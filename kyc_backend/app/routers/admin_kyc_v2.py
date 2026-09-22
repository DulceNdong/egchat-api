"""
Router /api/v1/admin/kyc — Endpoints admin adicionales del Orquestador KYC.

Añade sobre admin_kyc.py los endpoints que faltaban:
  POST /api/v1/admin/kyc/{id}/request-info → solicitar información adicional
  POST /api/v1/admin/kyc/{id}/block        → bloquear solicitud permanentemente
  POST /api/v1/admin/kyc/{id}/approve      → aprobar (alias explícito)
  POST /api/v1/admin/kyc/{id}/reject       → rechazar (alias explícito)
  GET  /api/v1/admin/kyc/{id}/audit        → historial de auditoría

Estos se montan en main.py con prefix /api/v1/admin/kyc
junto con los existentes en admin_kyc.py.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.dependencies import get_current_admin, require_roles, REVIEW_ROLES, BANGE_ROLES
from app.core.audit import log_action
from app.database import get_db
from app.models.admin_user import AdminUser
from app.models.kyc_application import KycApplication
from app.models.kyc_audit_log import KycAuditLog
from app.services.notifications import notify_user_kyc_decision

router = APIRouter()
logger = logging.getLogger("egchat.admin.kyc_v2")


# ── Schemas ───────────────────────────────────────────────────────
class RequestInfoBody(BaseModel):
    message: str = Field(
        ..., min_length=10,
        description="Mensaje claro al usuario indicando qué documentos o datos necesita aportar",
    )
    info_requested: list[str] = Field(
        default_factory=list,
        description="Lista de items requeridos: ['new_selfie', 'proof_of_address', ...]",
    )
    deadline_days: int = Field(
        default=7, ge=1, le=30,
        description="Días que tiene el usuario para responder",
    )


class BlockBody(BaseModel):
    reason: str = Field(..., min_length=10, description="Motivo del bloqueo (obligatorio)")
    notify_user: bool = Field(default=True)


class ApproveBody(BaseModel):
    notes: str | None = None


class RejectBody(BaseModel):
    reason: str = Field(..., min_length=5, description="Motivo del rechazo")
    notes:  str | None = None


class ActionResponse(BaseModel):
    success:        bool
    application_id: UUID
    new_status:     str
    message:        str


# ── Helper: cargar aplicación con usuario ─────────────────────────
async def _load_app(application_id: UUID, db: AsyncSession) -> KycApplication:
    result = await db.execute(
        select(KycApplication)
        .options(selectinload(KycApplication.user))
        .where(KycApplication.id == application_id)
    )
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(
            404, detail={"error": "KYC_NOT_FOUND", "message": "Solicitud KYC no encontrada"},
        )
    return app


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/admin/kyc/{id}/request-info
# ══════════════════════════════════════════════════════════════════
@router.post("/{application_id}/request-info", response_model=ActionResponse)
async def request_additional_info(
    application_id: UUID,
    body:  RequestInfoBody,
    admin: AdminUser   = Depends(require_roles(*REVIEW_ROLES)),
    db:    AsyncSession = Depends(get_db),
):
    """
    Solicita información adicional al usuario.
    Cambia el estado a PENDING_INFO y notifica al usuario con el mensaje
    indicando qué necesita aportar y el plazo.

    Solo disponible para COMPLIANCE_OFFICER y SUPER_ADMIN.
    BANGE no puede usar este endpoint (usa bank-decision en su lugar).
    """
    app = await _load_app(application_id, db)

    # Solo se puede solicitar info si la solicitud está en revisión
    reviewable = {
        "MANUAL_REVIEW", "PENDING_REVIEW", "under_review",
        "submitted", "IN_PROGRESS",
    }
    if app.status not in reviewable:
        raise HTTPException(
            409,
            detail={
                "error":   "KYC_NOT_REVIEWABLE",
                "message": f"No se puede solicitar información en estado: {app.status}",
            },
        )

    now = datetime.now(tz=timezone.utc)
    app.status            = "PENDING_INFO"
    app.reviewed_by_admin = admin.id
    app.reviewed_at       = now
    app.reviewer_notes    = body.message

    user = app.user
    await log_action(
        db,
        action        = "KYC_REQUEST_INFO",
        application_id= app.id,
        user_id       = user.id,
        admin_id      = admin.id,
        details={
            "message":        body.message,
            "info_requested": body.info_requested,
            "deadline_days":  body.deadline_days,
        },
    )
    await db.commit()

    # Notificar al usuario con el mensaje del revisor
    await notify_user_kyc_decision(
        user_id          = str(user.id),
        decision         = "REQUEST_INFO",
        rejection_reason = body.message,
    )

    logger.info(
        "Admin %s solicitó información adicional para app=%s",
        admin.id, application_id,
    )
    return ActionResponse(
        success        = True,
        application_id = application_id,
        new_status     = "PENDING_INFO",
        message        = (
            f"Información solicitada al usuario. Plazo: {body.deadline_days} días. "
            "El usuario recibirá una notificación."
        ),
    )


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/admin/kyc/{id}/block
# ══════════════════════════════════════════════════════════════════
@router.post("/{application_id}/block", response_model=ActionResponse)
async def block_application(
    application_id: UUID,
    body:  BlockBody,
    admin: AdminUser    = Depends(require_roles(*REVIEW_ROLES)),
    db:    AsyncSession = Depends(get_db),
):
    """
    Bloquea permanentemente una solicitud KYC y la cuenta del usuario.
    Acción irreversible — requiere motivo obligatorio.
    Registra en audit_log como acción de alto impacto.

    Solo COMPLIANCE_OFFICER y SUPER_ADMIN pueden bloquear.
    """
    app = await _load_app(application_id, db)

    # No se puede bloquear algo ya bloqueado o aprobado
    if app.status == "BLOCKED":
        raise HTTPException(
            409,
            detail={"error": "ALREADY_BLOCKED", "message": "Esta solicitud ya está bloqueada"},
        )
    if app.status in ("approved", "APPROVED"):
        raise HTTPException(
            409,
            detail={
                "error":   "KYC_ALREADY_APPROVED",
                "message": "No se puede bloquear una solicitud ya aprobada sin proceso formal",
            },
        )

    now  = datetime.now(tz=timezone.utc)
    user = app.user

    # Actualizar solicitud
    app.status            = "BLOCKED"
    app.reviewed_by_admin = admin.id
    app.reviewed_at       = now
    app.rejection_reason  = body.reason
    app.reviewer_notes    = f"[BLOCK] {body.reason}"

    # Actualizar usuario
    user.wallet_kyc_status = "suspended"
    user.status            = "BLOCKED"

    await log_action(
        db,
        action         = "KYC_BLOCKED",
        application_id = app.id,
        user_id        = user.id,
        admin_id       = admin.id,
        details={
            "reason":       body.reason,
            "notify_user":  body.notify_user,
            "blocked_by":   str(admin.id),
            "blocked_role": admin.role,
            "blocked_at":   now.isoformat(),
        },
    )
    await db.commit()

    if body.notify_user:
        await notify_user_kyc_decision(
            user_id          = str(user.id),
            decision         = "BLOCKED",
            rejection_reason = body.reason,
        )

    logger.warning(
        "KYC BLOQUEADO: app=%s user=%s por admin=%s — %s",
        application_id, user.id, admin.id, body.reason,
    )
    return ActionResponse(
        success        = True,
        application_id = application_id,
        new_status     = "BLOCKED",
        message        = "Solicitud bloqueada y cuenta del usuario suspendida.",
    )


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/admin/kyc/{id}/approve  (alias explícito)
# ══════════════════════════════════════════════════════════════════
@router.post("/{application_id}/approve", response_model=ActionResponse)
async def approve_application(
    application_id: UUID,
    body:  ApproveBody,
    admin: AdminUser    = Depends(require_roles(*REVIEW_ROLES)),
    db:    AsyncSession = Depends(get_db),
):
    """Aprueba la solicitud KYC y activa el monedero del usuario."""
    app = await _load_app(application_id, db)

    final_statuses = {"approved", "APPROVED", "BLOCKED", "REJECTED", "rejected"}
    if app.status in final_statuses:
        raise HTTPException(
            409,
            detail={
                "error":   "KYC_ALREADY_FINAL",
                "message": f"Estado final no modificable: {app.status}",
            },
        )

    now  = datetime.now(tz=timezone.utc)
    user = app.user

    app.status            = "APPROVED"
    app.reviewed_by_admin = admin.id
    app.reviewed_at       = now
    app.reviewer_notes    = body.notes

    user.wallet_kyc_status      = "approved"
    user.wallet_kyc_reviewed_at = now
    user.status                 = "ACTIVE"

    await log_action(
        db,
        action         = "KYC_APPROVED",
        application_id = app.id,
        user_id        = user.id,
        admin_id       = admin.id,
        details        = {"notes": body.notes},
    )
    await db.commit()

    await notify_user_kyc_decision(str(user.id), "APPROVED")

    return ActionResponse(
        success        = True,
        application_id = application_id,
        new_status     = "APPROVED",
        message        = "Solicitud aprobada. Monedero activado.",
    )


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/admin/kyc/{id}/reject  (alias explícito)
# ══════════════════════════════════════════════════════════════════
@router.post("/{application_id}/reject", response_model=ActionResponse)
async def reject_application(
    application_id: UUID,
    body:  RejectBody,
    admin: AdminUser    = Depends(require_roles(*REVIEW_ROLES)),
    db:    AsyncSession = Depends(get_db),
):
    """Rechaza la solicitud KYC. El usuario puede volver a intentarlo."""
    app = await _load_app(application_id, db)

    if app.status in ("approved", "APPROVED", "BLOCKED"):
        raise HTTPException(
            409,
            detail={
                "error":   "KYC_ALREADY_FINAL",
                "message": f"Estado final no modificable: {app.status}",
            },
        )

    now  = datetime.now(tz=timezone.utc)
    user = app.user

    app.status            = "REJECTED"
    app.reviewed_by_admin = admin.id
    app.reviewed_at       = now
    app.rejection_reason  = body.reason
    app.reviewer_notes    = body.notes

    user.wallet_kyc_status        = "rejected"
    user.wallet_kyc_reject_reason = body.reason

    await log_action(
        db,
        action         = "KYC_REJECTED",
        application_id = app.id,
        user_id        = user.id,
        admin_id       = admin.id,
        details        = {"reason": body.reason, "notes": body.notes},
    )
    await db.commit()

    await notify_user_kyc_decision(
        str(user.id), "REJECTED", rejection_reason=body.reason
    )

    return ActionResponse(
        success        = True,
        application_id = application_id,
        new_status     = "REJECTED",
        message        = "Solicitud rechazada. El usuario puede reintentar.",
    )


# ══════════════════════════════════════════════════════════════════
# GET /api/v1/admin/kyc/{id}/audit
# ══════════════════════════════════════════════════════════════════
@router.get("/{application_id}/audit")
async def get_audit_trail(
    application_id: UUID,
    admin: AdminUser    = Depends(get_current_admin),
    db:    AsyncSession = Depends(get_db),
):
    """
    Devuelve el historial de auditoría completo de una solicitud KYC.
    El log es INMUTABLE — solo lectura (triggers de BD bloquean UPDATE/DELETE).
    """
    result = await db.execute(
        select(KycAuditLog)
        .where(KycAuditLog.application_id == application_id)
        .order_by(KycAuditLog.created_at.asc())
    )
    entries = result.scalars().all()

    return {
        "application_id": str(application_id),
        "total_entries":  len(entries),
        "audit_trail": [
            {
                "id":            entry.id,
                "action":        entry.action,
                "performed_by":  str(entry.performed_by) if entry.performed_by else None,
                "performed_role":entry.performed_role,
                "details":       entry.details,
                "ip_address":    str(entry.ip_address) if entry.ip_address else None,
                "created_at":    entry.created_at.isoformat(),
            }
            for entry in entries
        ],
    }
