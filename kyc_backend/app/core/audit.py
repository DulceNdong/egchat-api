"""Helper para insertar registros INMUTABLES en kyc_audit_log."""
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.kyc_audit_log import KycAuditLog


async def log_action(
    db: AsyncSession,
    action: str,
    *,
    application_id: UUID | None = None,
    user_id: UUID | None = None,
    admin_id: UUID | None = None,
    performed_by: UUID | None = None,
    performed_role: str | None = None,
    details: dict | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    """
    Inserta un registro en kyc_audit_log.
    El trigger de la BD impide UPDATE/DELETE en esta tabla (INMUTABLE).
    """
    entry = KycAuditLog(
        application_id=application_id,
        user_id=user_id,
        admin_id=admin_id,
        action=action,
        performed_by=performed_by or admin_id or user_id,
        performed_role=performed_role or ("admin" if admin_id else "user"),
        details=details or {},
        ip_address=ip_address,
        user_agent=user_agent,
    )
    db.add(entry)
    # No hacemos commit aquí — el llamador gestiona la transacción
