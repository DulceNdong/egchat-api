"""
Router /aml — monitorización AML: transacciones flaggeadas + SAR.

Rutas:
  GET  /transactions/flagged         → lista transacciones flaggeadas (paginada)
  POST /transactions/{id}/flag       → flaggear una transacción manualmente
  POST /transactions/{id}/review     → marcar como revisada (con/sin clear_flag)
  GET  /sar                          → listar SAR
  POST /sar                          → crear nuevo SAR
  GET  /sar/{id}                     → detalle SAR
  PUT  /sar/{id}                     → actualizar SAR
  POST /sar/{id}/send                → enviar SAR a ANIF

Roles requeridos:
  AML_ROLES (SUPER_ADMIN, COMPLIANCE_OFFICER) para todas las acciones de escritura
  READ_ROLES para solo lectura
"""
from __future__ import annotations
import logging
import math
from datetime import datetime, timedelta, timezone
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.dependencies import (
    get_current_admin, require_roles,
    AML_ROLES, READ_ROLES,
)
from app.config import get_settings
from app.core.audit import log_action
from app.core.encryption import encrypt_if_present, decrypt_if_present
from app.database import get_db
from app.models.admin_user import AdminUser
from app.models.sar import SuspiciousActivityReport
from app.models.transaction import Transaction
from app.schemas.aml import (
    FlagTransactionRequest, FlagTransactionResponse,
    FlaggedTransactionItem, FlaggedTransactionsResponse,
    ReviewTransactionRequest,
    SarCreateRequest, SarListResponse, SarResponse,
    SarSendResponse, SarUpdateRequest,
)

router = APIRouter()
logger = logging.getLogger("egchat.aml.router")
settings = get_settings()


# ══════════════════════════════════════════════════════════════════
# TRANSACCIONES FLAGGEADAS
# ══════════════════════════════════════════════════════════════════

# ── GET /aml/transactions/flagged ────────────────────────────────
@router.get("/transactions/flagged", response_model=FlaggedTransactionsResponse)
async def list_flagged_transactions(
    page:        int = Query(default=1, ge=1),
    page_size:   int = Query(default=20, ge=1, le=100),
    reviewed:    bool | None = Query(default=None),
    flag_type:   str | None  = Query(default=None),
    admin: AdminUser = Depends(require_roles(*READ_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    filters = [Transaction.flagged == True]
    if reviewed is not None:
        filters.append(Transaction.aml_reviewed == reviewed)
    if flag_type:
        filters.append(Transaction.flag_type == flag_type.upper())

    total = await db.scalar(
        select(func.count(Transaction.id)).where(and_(*filters))
    ) or 0

    result = await db.execute(
        select(Transaction)
        .where(and_(*filters))
        .order_by(Transaction.flagged_at.desc().nullslast())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    txs = result.scalars().all()

    return FlaggedTransactionsResponse(
        items=[FlaggedTransactionItem.model_validate(tx) for tx in txs],
        total=total,
        page=page,
        page_size=page_size,
    )


# ── POST /aml/transactions/{id}/flag ─────────────────────────────
@router.post("/transactions/{tx_id}/flag", response_model=FlagTransactionResponse)
async def flag_transaction(
    tx_id: UUID,
    body: FlagTransactionRequest,
    admin: AdminUser = Depends(require_roles(*AML_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Transaction).where(Transaction.id == tx_id))
    tx = result.scalar_one_or_none()
    if not tx:
        raise HTTPException(404, detail={"error": "TX_NOT_FOUND", "message": "Transacción no encontrada"})

    now = datetime.now(tz=timezone.utc)
    tx.flagged     = True
    tx.flag_type   = body.flag_type
    tx.flag_reason = body.flag_reason
    tx.flagged_at  = now
    tx.flagged_by  = admin.id

    await log_action(
        db, action="TX_MANUAL_FLAGGED", admin_id=admin.id, user_id=tx.user_id,
        details={
            "transaction_id": str(tx_id),
            "amount":     str(tx.amount),
            "flag_type":  body.flag_type,
            "flag_reason": body.flag_reason,
        },
    )
    await db.commit()

    # ── Conectar AML → KYC: escalar revisión si el contexto lo requiere ──
    import asyncio as _asyncio
    from app.services.aml_kyc_bridge import escalate_kyc_on_new_flag
    _asyncio.create_task(
        escalate_kyc_on_new_flag(db, tx.user_id, tx_id, body.flag_type)
    )

    logger.info("TX %s flaggeada manualmente por admin %s [%s]", tx_id, admin.id, body.flag_type)
    return FlagTransactionResponse(
        success=True,
        transaction_id=tx_id,
        flag_type=body.flag_type,
        message=f"Transacción flaggeada como {body.flag_type}",
    )


# ── POST /aml/transactions/{id}/review ───────────────────────────
@router.post("/transactions/{tx_id}/review", status_code=200)
async def review_transaction(
    tx_id: UUID,
    body: ReviewTransactionRequest,
    admin: AdminUser = Depends(require_roles(*AML_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Transaction).where(Transaction.id == tx_id))
    tx = result.scalar_one_or_none()
    if not tx:
        raise HTTPException(404, detail={"error": "TX_NOT_FOUND", "message": "Transacción no encontrada"})

    now = datetime.now(tz=timezone.utc)
    tx.aml_reviewed    = True
    tx.aml_reviewed_by = admin.id
    tx.aml_reviewed_at = now
    tx.aml_notes       = body.notes

    if body.clear_flag:
        tx.flagged = False

    await log_action(
        db, action="TX_AML_REVIEWED", admin_id=admin.id, user_id=tx.user_id,
        details={
            "transaction_id": str(tx_id),
            "notes": body.notes,
            "flag_cleared": body.clear_flag,
        },
    )
    await db.commit()

    return {
        "success": True,
        "transaction_id": str(tx_id),
        "aml_reviewed": True,
        "flag_cleared": body.clear_flag,
    }


# ══════════════════════════════════════════════════════════════════
# SAR — Suspicious Activity Reports
# ══════════════════════════════════════════════════════════════════

def _sar_to_response(sar: SuspiciousActivityReport, reporter_email: str | None = None) -> SarResponse:
    deadline = sar.detected_at + timedelta(hours=72)
    return SarResponse(
        id=sar.id,
        application_id=sar.application_id,
        transaction_ids=sar.transaction_ids or [],
        report_type=sar.report_type,
        description=sar.description,
        indicators=sar.indicators or [],
        status=sar.status,
        amount_involved=sar.amount_involved,
        currency=sar.currency,
        anif_reference=sar.anif_reference,
        detected_at=sar.detected_at,
        deadline_at=deadline,
        sent_at=sar.sent_at,
        created_at=sar.created_at,
        reported_by_email=reporter_email,
        overdue=(deadline < datetime.now(tz=timezone.utc) and sar.status not in
                 ("SENT_TO_ANIF", "ACKNOWLEDGED", "CLOSED")),
    )


# ── GET /aml/sar ──────────────────────────────────────────────────
@router.get("/sar", response_model=SarListResponse)
async def list_sars(
    page:       int = Query(default=1, ge=1),
    page_size:  int = Query(default=20, ge=1, le=100),
    sar_status: str | None = Query(default=None, alias="status"),
    overdue_only: bool = Query(default=False),
    admin: AdminUser = Depends(require_roles(*READ_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    filters: list = []
    if sar_status:
        filters.append(SuspiciousActivityReport.status == sar_status.upper())
    if overdue_only:
        deadline_threshold = func.now() - func.cast("72 hours", type_=None)
        filters.append(SuspiciousActivityReport.detected_at < deadline_threshold)
        filters.append(SuspiciousActivityReport.status.notin_(
            ["SENT_TO_ANIF", "ACKNOWLEDGED", "CLOSED"]
        ))

    total = await db.scalar(
        select(func.count(SuspiciousActivityReport.id))
        .where(and_(*filters) if filters else True)
    ) or 0

    result = await db.execute(
        select(SuspiciousActivityReport)
        .options(selectinload(SuspiciousActivityReport.reporter))
        .where(and_(*filters) if filters else True)
        .order_by(SuspiciousActivityReport.detected_at.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    sars = result.scalars().all()

    items = [
        _sar_to_response(s, s.reporter.email if s.reporter else None)
        for s in sars
    ]
    return SarListResponse(
        items=items,
        total=total,
        page=page,
        page_size=math.ceil(total / page_size) if total else 1,
    )


# ── POST /aml/sar ─────────────────────────────────────────────────
@router.post("/sar", response_model=SarResponse, status_code=status.HTTP_201_CREATED)
async def create_sar(
    body: SarCreateRequest,
    admin: AdminUser = Depends(require_roles(*AML_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(tz=timezone.utc)

    sar = SuspiciousActivityReport(
        application_id  = body.application_id,
        transaction_ids = [str(t) for t in body.transaction_ids],
        reported_by     = admin.id,
        report_type     = body.report_type,
        description     = body.description,
        indicators      = body.indicators,
        subject_name    = body.subject_name,
        subject_id_type = body.subject_id_type,
        # Cifrar número de documento del sujeto
        subject_id_num  = encrypt_if_present(body.subject_id_num),
        amount_involved = body.amount_involved,
        currency        = body.currency,
        status          = "DRAFT",
        detected_at     = now,
    )
    db.add(sar)
    await db.flush()   # obtener sar.id

    await log_action(
        db, action="SAR_CREATED", admin_id=admin.id,
        application_id=body.application_id,
        details={
            "sar_id":      str(sar.id),
            "report_type": body.report_type,
            "indicators":  body.indicators,
            "amount":      str(body.amount_involved),
        },
    )
    await db.commit()

    logger.info("SAR creado: %s tipo=%s por admin=%s", sar.id, body.report_type, admin.id)
    return _sar_to_response(sar, admin.email)


# ── GET /aml/sar/{id} ─────────────────────────────────────────────
@router.get("/sar/{sar_id}", response_model=SarResponse)
async def get_sar(
    sar_id: UUID,
    admin: AdminUser = Depends(require_roles(*READ_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SuspiciousActivityReport)
        .options(selectinload(SuspiciousActivityReport.reporter))
        .where(SuspiciousActivityReport.id == sar_id)
    )
    sar = result.scalar_one_or_none()
    if not sar:
        raise HTTPException(404, detail={"error": "SAR_NOT_FOUND", "message": "SAR no encontrado"})
    return _sar_to_response(sar, sar.reporter.email if sar.reporter else None)


# ── PUT /aml/sar/{id} ─────────────────────────────────────────────
@router.put("/sar/{sar_id}", response_model=SarResponse)
async def update_sar(
    sar_id: UUID,
    body: SarUpdateRequest,
    admin: AdminUser = Depends(require_roles(*AML_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SuspiciousActivityReport)
        .options(selectinload(SuspiciousActivityReport.reporter))
        .where(SuspiciousActivityReport.id == sar_id)
    )
    sar = result.scalar_one_or_none()
    if not sar:
        raise HTTPException(404, detail={"error": "SAR_NOT_FOUND", "message": "SAR no encontrado"})

    if sar.status in ("SENT_TO_ANIF", "ACKNOWLEDGED"):
        raise HTTPException(409, detail={
            "error": "SAR_ALREADY_SENT",
            "message": "No puedes editar un SAR ya enviado a la ANIF",
        })

    if body.description   is not None: sar.description    = body.description
    if body.indicators    is not None: sar.indicators      = body.indicators
    if body.subject_name  is not None: sar.subject_name    = body.subject_name
    if body.amount_involved is not None: sar.amount_involved = body.amount_involved
    if body.status        is not None: sar.status          = body.status
    if body.anif_reference is not None: sar.anif_reference = body.anif_reference

    await log_action(
        db, action="SAR_UPDATED", admin_id=admin.id,
        details={"sar_id": str(sar_id), "changes": body.model_dump(exclude_none=True)},
    )
    await db.commit()

    return _sar_to_response(sar, sar.reporter.email if sar.reporter else None)


# ── POST /aml/sar/{id}/send ───────────────────────────────────────
@router.post("/sar/{sar_id}/send", response_model=SarSendResponse)
async def send_sar_to_anif(
    sar_id: UUID,
    admin: AdminUser = Depends(require_roles(*AML_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SuspiciousActivityReport)
        .where(SuspiciousActivityReport.id == sar_id)
    )
    sar = result.scalar_one_or_none()
    if not sar:
        raise HTTPException(404, detail={"error": "SAR_NOT_FOUND", "message": "SAR no encontrado"})

    if sar.status in ("SENT_TO_ANIF", "ACKNOWLEDGED"):
        raise HTTPException(409, detail={
            "error": "SAR_ALREADY_SENT",
            "message": "Este SAR ya fue enviado a la ANIF",
        })

    if sar.status not in ("APPROVED", "DRAFT", "PENDING_REVIEW"):
        raise HTTPException(400, detail={
            "error": "SAR_NOT_READY",
            "message": f"El SAR debe estar en estado APPROVED para enviarse (actual: {sar.status})",
        })

    # Construir payload SIF 1.0
    sif_payload = _build_sif_payload(sar)
    sar.sif_payload = sif_payload

    # Intentar envío a ANIF si hay URL configurada
    anif_reference: str | None = None
    if settings.anif_api_url and settings.anif_api_key:
        anif_reference = await _send_to_anif(sif_payload, settings.anif_api_url, settings.anif_api_key)
    else:
        # Sin API ANIF → generar referencia temporal (entorno dev/test)
        import secrets
        anif_reference = f"ANIF-LOCAL-{secrets.token_hex(6).upper()}"
        logger.warning("ANIF API no configurada — referencia simulada: %s", anif_reference)

    now = datetime.now(tz=timezone.utc)
    sar.status          = "SENT_TO_ANIF"
    sar.anif_reference  = anif_reference
    sar.sent_at         = now

    await log_action(
        db, action="SAR_SENT_ANIF", admin_id=admin.id,
        details={
            "sar_id":          str(sar_id),
            "anif_reference":  anif_reference,
            "report_type":     sar.report_type,
            "amount_involved": str(sar.amount_involved),
        },
    )
    await db.commit()

    logger.info("SAR %s enviado a ANIF — ref: %s", sar_id, anif_reference)
    return SarSendResponse(
        success=True,
        sar_id=sar_id,
        anif_reference=anif_reference,
        message=f"SAR enviado a la ANIF. Referencia: {anif_reference}",
    )


# ── Helpers internos ──────────────────────────────────────────────
def _build_sif_payload(sar: SuspiciousActivityReport) -> dict:
    """
    Construye el payload en formato SIF 1.0 para la ANIF de Guinea Ecuatorial.
    Adaptar campos cuando se tenga la especificación exacta del formato ANIF-GQ.
    """
    return {
        "sif_version":    "1.0",
        "report_type":    sar.report_type,
        "institution":    "EGChat - Monedero Digital",
        "bank_partner":   "BANGE - Banco Nacional de Guinea Ecuatorial",
        "report_date":    datetime.now(tz=timezone.utc).isoformat(),
        "subject": {
            "name":       sar.subject_name,
            "id_type":    sar.subject_id_type,
            # subject_id_num se descifra solo para el payload de envío, nunca se almacena en claro
            "id_number":  decrypt_if_present(sar.subject_id_num) if sar.subject_id_num else None,
        },
        "transaction": {
            "amount":     str(sar.amount_involved),
            "currency":   sar.currency,
            "ids":        [str(t) for t in (sar.transaction_ids or [])],
        },
        "description":    sar.description,
        "indicators":     sar.indicators,
        "detected_at":    sar.detected_at.isoformat(),
        "internal_id":    str(sar.id),
    }


async def _send_to_anif(payload: dict, api_url: str, api_key: str) -> str:
    """Envía el payload SIF a la API de la ANIF y devuelve la referencia."""
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{api_url.rstrip('/')}/report",
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type":  "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("reference") or data.get("id") or "ANIF-OK"
    except Exception as e:
        logger.error("Error al enviar SAR a ANIF: %s", e)
        raise HTTPException(502, detail={
            "error":   "ANIF_SEND_ERROR",
            "message": f"No se pudo enviar a la ANIF: {e}",
        })
