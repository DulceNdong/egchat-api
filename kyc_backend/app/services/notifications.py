"""
Servicio de notificaciones — avisa al usuario cuando cambia su estado KYC.
Integra con el Render API existente via POST /api/push/kyc-update.
En producción también enviaría email/SMS.
"""
from __future__ import annotations
import logging
import httpx
from app.config import get_settings

logger = logging.getLogger("egchat.notifications")
settings = get_settings()

# URL del Render API existente de EGChat
_RENDER_API = "https://egchat-api-xlxj.onrender.com"

_MESSAGES: dict[str, tuple[str, str]] = {
    "APPROVED":        ("✅ Monedero activado",
                        "Tu identidad ha sido verificada. ¡Ya puedes usar todas las funciones del monedero!"),
    "AUTO_APPROVED":   ("✅ Monedero activado",
                        "Tu verificación fue aprobada automáticamente. ¡Bienvenido al monedero digital EGChat!"),
    "REJECTED":        ("❌ Verificación rechazada",
                        "Tu solicitud KYC fue rechazada. Puedes volver a intentarlo con documentos correctos."),
    "BLOCKED":         ("🚫 Cuenta bloqueada",
                        "Tu cuenta ha sido bloqueada. Contacta con soporte para más información."),
    "BANK_APPROVED":   ("🏦 Aprobado por BANGE",
                        "BANGE ha aprobado tu verificación. Tu monedero está activo."),
    "BANK_REJECTED":   ("🏦 Rechazado por BANGE",
                        "BANGE no ha podido verificar tu identidad. Contacta con soporte."),
    "MANUAL_REVIEW":   ("⏳ En revisión",
                        "Tu solicitud requiere revisión manual. Te avisaremos en 24-48 horas hábiles."),
}


async def notify_user_kyc_decision(
    user_id: str,
    decision: str,
    rejection_reason: str | None = None,
) -> None:
    """
    Envía notificación push al usuario a través del Render API.
    Silencioso en caso de error (no bloquea el flujo principal).
    """
    title, body = _MESSAGES.get(decision, ("📋 Actualización KYC",
                                            "Tu estado KYC ha cambiado."))
    if rejection_reason and decision in ("REJECTED", "BANK_REJECTED"):
        body += f"\n\nMotivo: {rejection_reason}"

    payload = {
        "user_id":  user_id,
        "title":    title,
        "body":     body,
        "data":     {"type": "KYC_UPDATE", "decision": decision},
    }

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                f"{_RENDER_API}/api/push/kyc-update",
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code not in (200, 201, 204):
                logger.warning("Push KYC notification falló: %s %s", resp.status_code, resp.text)
            else:
                logger.info("Push KYC enviado a user=%s decision=%s", user_id, decision)
    except Exception as e:
        logger.warning("Error al enviar push KYC user=%s: %s", user_id, e)
