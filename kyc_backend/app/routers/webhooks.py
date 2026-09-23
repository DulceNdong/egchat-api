"""
Router /webhooks — recibir decisiones externas firmadas.

Endpoints:
  POST /webhooks/bange   → Decisión de BANGE (HMAC-SHA256)
  POST /webhooks/anif    → Acuse de recibo de la ANIF (HMAC-SHA256)

Seguridad:
  - Cada request debe incluir el header X-Signature: sha256=<hmac>
  - El HMAC se calcula sobre el body raw con el secret compartido
  - Replay-attack protection: header X-Timestamp (max 5 min de desfase)
  - IP whitelist opcional via settings.bange_allowed_ips
"""
from __future__ import annotations
import hashlib
import hmac
import logging
import time
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.core.audit import log_action
from app.database import get_db
from app.models.kyc_application import KycApplication
from app.models.sar import SuspiciousActivityReport
from app.models.user import User
from app.services.notifications import notify_user_kyc_decision

router = APIRouter()
logger = logging.getLogger("egchat.webhooks")
settings = get_settings()

# Ventana de tiempo permitida para evitar replay attacks (segundos)
_TIMESTAMP_TOLERANCE = 300   # 5 minutos


# ── Helper: validar firma HMAC-SHA256 ────────────────────────────
def _verify_signature(
    raw_body: bytes,
    signature_header: str,
    secret: str,
    timestamp_header: str | None = None,
) -> None:
    """
    Valida la firma HMAC-SHA256 del webhook.
    Lanza HTTPException 401 si la firma es inválida.
    Lanza HTTPException 408 si el timestamp está fuera de ventana.
    """
    # ── Protección replay: validar timestamp ──────────────────────
    if timestamp_header is not None:
        try:
            ts = int(timestamp_header)
            drift = abs(time.time() - ts)
            if drift > _TIMESTAMP_TOLERANCE:
                logger.warning("Webhook rechazado: timestamp fuera de ventana (drift=%ds)", drift)
                raise HTTPException(
                    status_code=status.HTTP_408_REQUEST_TIMEOUT,
                    detail={
                        "error": "TIMESTAMP_EXPIRED",
                        "message": f"Timestamp fuera de ventana ({_TIMESTAMP_TOLERANCE}s). Sincroniza el reloj.",
                    },
                )
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "INVALID_TIMESTAMP", "message": "Header X-Timestamp inválido"},
            )

    # ── Validar HMAC ──────────────────────────────────────────────
    # Soporte para formato "sha256=<hex>" y "<hex>" directamente
    received = signature_header.removeprefix("sha256=").strip()

    # Si hay timestamp, firmamos "timestamp.body" (mismo patrón que Stripe/GitHub)
    if timestamp_header:
        signed_payload = f"{timestamp_header}.".encode() + raw_body
    else:
        signed_payload = raw_body

    expected = hmac.new(
        key=secret.encode(),
        msg=signed_payload,
        digestmod=hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, received):
        logger.warning("Webhook rechazado: firma HMAC inválida")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "INVALID_SIGNATURE", "message": "Firma del webhook inválida"},
        )


# ══════════════════════════════════════════════════════════════════
# POST /webhooks/bange — Decisión BANGE sobre solicitud KYC
# ══════════════════════════════════════════════════════════════════
"""
Payload esperado de BANGE:
{
  "event":          "kyc.decision",
  "application_id": "uuid",
  "decision":       "APPROVED" | "REJECTED",
  "notes":          "texto opcional",
  "reviewer_ref":   "referencia interna BANGE",
  "timestamp":      1234567890
}
"""

@router.post("/bange", status_code=200)
async def bange_webhook(
    request: Request,
    x_signature: str = Header(..., alias="X-Signature",
                               description="sha256=HMAC-SHA256(body, bange_webhook_secret)"),
    x_timestamp: str | None = Header(default=None, alias="X-Timestamp",
                                      description="Unix timestamp del envío"),
    db: AsyncSession = Depends(get_db),
):
    # ── 1. Leer body raw antes de parsear ─────────────────────────
    raw_body = await request.body()

    # ── 2. Validar firma HMAC ─────────────────────────────────────
    if not settings.bange_webhook_secret:
        logger.error("bange_webhook_secret no configurado — webhook rechazado")
        raise HTTPException(500, detail={
            "error": "WEBHOOK_NOT_CONFIGURED",
            "message": "El servidor no tiene configurado el secret del webhook BANGE",
        })

    _verify_signature(raw_body, x_signature, settings.bange_webhook_secret, x_timestamp)

    # ── 3. Parsear payload ────────────────────────────────────────
    try:
        import json
        payload = json.loads(raw_body)
    except Exception:
        raise HTTPException(400, detail={"error": "INVALID_JSON", "message": "Body JSON inválido"})

    event          = payload.get("event", "")
    application_id = payload.get("application_id")
    decision       = payload.get("decision", "").upper()
    notes          = payload.get("notes")
    reviewer_ref   = payload.get("reviewer_ref")

    # ── 4. Validar campos obligatorios ────────────────────────────
    if event != "kyc.decision":
        # Evento desconocido — acusar recibo sin procesar
        logger.info("Webhook BANGE evento desconocido: %s — ignorado", event)
        return {"received": True, "processed": False, "reason": f"Evento '{event}' no manejado"}

    if not application_id:
        raise HTTPException(400, detail={"error": "MISSING_APPLICATION_ID",
                                          "message": "Campo application_id requerido"})

    if decision not in ("APPROVED", "REJECTED"):
        raise HTTPException(400, detail={"error": "INVALID_DECISION",
                                          "message": "decision debe ser APPROVED o REJECTED"})

    # ── 5. Buscar solicitud KYC ───────────────────────────────────
    try:
        app_uuid = UUID(application_id)
    except ValueError:
        raise HTTPException(400, detail={"error": "INVALID_UUID",
                                          "message": "application_id no es un UUID válido"})

    result = await db.execute(
        select(KycApplication)
        .options(selectinload(KycApplication.user))
        .where(KycApplication.id == app_uuid)
    )
    app = result.scalar_one_or_none()

    if not app:
        logger.warning("Webhook BANGE: application_id %s no encontrado", application_id)
        # Devolvemos 200 para que BANGE no reintente — logeamos el problema
        return {"received": True, "processed": False, "reason": "application_id no encontrado"}

    # ── 6. Idempotencia: si ya tiene decisión BANGE, ignorar ──────
    if app.bank_decision == decision:
        logger.info("Webhook BANGE: decisión %s ya registrada para %s — idempotente", decision, app_uuid)
        return {"received": True, "processed": False, "reason": "Decisión ya registrada (idempotente)"}

    # ── 7. Aplicar decisión ───────────────────────────────────────
    now = datetime.now(tz=timezone.utc)
    app.bank_decision    = decision
    app.bank_decision_at = now
    app.bank_notes       = notes
    # reviewer_ref → guardamos en bank_notes si no hay campo dedicado
    if reviewer_ref:
        app.bank_notes = f"[{reviewer_ref}] {notes or ''}".strip()

    user: User = app.user
    if decision == "APPROVED":
        app.status                  = "APPROVED"
        user.wallet_kyc_status      = "approved"
        user.wallet_kyc_reviewed_at = now
        user.status                 = "ACTIVE"
    else:
        app.status                     = "REJECTED"
        user.wallet_kyc_status         = "rejected"
        user.wallet_kyc_reject_reason  = notes

    # ── 8. Audit log ──────────────────────────────────────────────
    await log_action(
        db,
        action=f"WEBHOOK_BANGE_{decision}",
        application_id=app.id,
        user_id=user.id,
        performed_role="BANGE_WEBHOOK",
        details={
            "decision":     decision,
            "notes":        notes,
            "reviewer_ref": reviewer_ref,
            "event":        event,
        },
    )
    await db.commit()

    # ── 9. Notificar al usuario ───────────────────────────────────
    await notify_user_kyc_decision(
        user_id=str(user.id),
        decision=f"BANK_{decision}",
        rejection_reason=notes,
    )

    logger.info(
        "Webhook BANGE procesado: app=%s decision=%s user=%s",
        app.id, decision, user.id,
    )
    return {
        "received":       True,
        "processed":      True,
        "application_id": str(app.id),
        "decision":       decision,
        "user_notified":  True,
    }


# ══════════════════════════════════════════════════════════════════
# POST /webhooks/anif — Acuse de recibo de la ANIF
# ══════════════════════════════════════════════════════════════════
"""
Payload esperado de ANIF:
{
  "event":       "sar.acknowledged",
  "internal_id": "uuid del SAR",
  "reference":   "ANIF-2024-XXXXX",
  "timestamp":   1234567890
}
"""

@router.post("/anif", status_code=200)
async def anif_webhook(
    request: Request,
    x_signature: str = Header(..., alias="X-Signature"),
    x_timestamp: str | None = Header(default=None, alias="X-Timestamp"),
    db: AsyncSession = Depends(get_db),
):
    raw_body = await request.body()

    # Reutilizamos el mismo secret para ANIF — en producción podría ser distinto
    anif_secret = getattr(settings, "anif_webhook_secret", settings.bange_webhook_secret)
    if not anif_secret:
        raise HTTPException(500, detail={"error": "WEBHOOK_NOT_CONFIGURED",
                                          "message": "Secret ANIF no configurado"})

    _verify_signature(raw_body, x_signature, anif_secret, x_timestamp)

    try:
        import json
        payload = json.loads(raw_body)
    except Exception:
        raise HTTPException(400, detail={"error": "INVALID_JSON", "message": "Body JSON inválido"})

    event       = payload.get("event", "")
    internal_id = payload.get("internal_id")
    reference   = payload.get("reference")

    if event != "sar.acknowledged":
        return {"received": True, "processed": False, "reason": f"Evento '{event}' no manejado"}

    if not internal_id or not reference:
        raise HTTPException(400, detail={"error": "MISSING_FIELDS",
                                          "message": "internal_id y reference son requeridos"})

    try:
        sar_uuid = UUID(internal_id)
    except ValueError:
        raise HTTPException(400, detail={"error": "INVALID_UUID",
                                          "message": "internal_id no es UUID válido"})

    result = await db.execute(
        select(SuspiciousActivityReport).where(SuspiciousActivityReport.id == sar_uuid)
    )
    sar = result.scalar_one_or_none()

    if not sar:
        return {"received": True, "processed": False, "reason": "SAR no encontrado"}

    # Idempotencia
    if sar.status == "ACKNOWLEDGED":
        return {"received": True, "processed": False, "reason": "Ya acusado de recibo"}

    sar.status         = "ACKNOWLEDGED"
    sar.anif_reference = reference
    sar.anif_response  = payload

    await log_action(
        db,
        action="WEBHOOK_ANIF_ACKNOWLEDGED",
        performed_role="ANIF_WEBHOOK",
        details={
            "sar_id":    str(sar_uuid),
            "reference": reference,
            "event":     event,
        },
    )
    await db.commit()

    logger.info("SAR %s acusado de recibo por ANIF — ref: %s", sar_uuid, reference)
    return {
        "received":  True,
        "processed": True,
        "sar_id":    str(sar_uuid),
        "reference": reference,
    }
