"""
Rate-limit KYC por user_id — máx 5 intentos en 24h (configurable).

La decisión se basa en filas en kyc_attempts (BD), no en caché de memoria,
para que sea correcta incluso con múltiples instancias del servidor.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.kyc_attempt import KycAttempt

settings = get_settings()


async def check_and_record_attempt(
    db: AsyncSession,
    user_id: UUID,
    ip_address: str | None = None,
    user_agent: str | None = None,
    session_id: UUID | None = None,
) -> tuple[bool, str | None]:
    """
    Verifica si el usuario puede iniciar un intento KYC.
    Registra el intento (success=False inicialmente).

    Devuelve:
        (allowed: bool, block_reason: str | None)

    El caller debe llamar a mark_attempt_success() si el init prospera.
    """
    max_attempts = getattr(settings, "kyc_max_attempts_per_day", 5)
    window_hours = getattr(settings, "kyc_attempt_window_hours", 24)

    window_start = datetime.now(tz=timezone.utc) - timedelta(hours=window_hours)

    # Contar intentos en la ventana temporal
    count = await db.scalar(
        select(func.count(KycAttempt.id)).where(
            and_(
                KycAttempt.user_id == user_id,
                KycAttempt.attempted_at >= window_start,
            )
        )
    ) or 0

    if count >= max_attempts:
        reason = (
            f"Límite de {max_attempts} intentos KYC por {window_hours}h alcanzado. "
            "Inténtalo de nuevo mañana."
        )
        # Registrar el intento bloqueado
        db.add(KycAttempt(
            user_id=user_id,
            session_id=session_id,
            ip_address=ip_address,
            user_agent=user_agent,
            success=False,
            blocked_reason=reason,
        ))
        await db.flush()
        return False, reason

    # Registrar el intento permitido (success=False hasta que el init complete)
    attempt = KycAttempt(
        user_id=user_id,
        session_id=session_id,
        ip_address=ip_address,
        user_agent=user_agent,
        success=False,
    )
    db.add(attempt)
    await db.flush()
    return True, None


async def mark_attempt_success(
    db: AsyncSession,
    user_id: UUID,
    session_id: UUID,
) -> None:
    """Marca el intento más reciente del usuario como exitoso."""
    result = await db.execute(
        select(KycAttempt)
        .where(and_(
            KycAttempt.user_id == user_id,
            KycAttempt.success == False,
            KycAttempt.blocked_reason.is_(None),
        ))
        .order_by(KycAttempt.attempted_at.desc())
        .limit(1)
    )
    attempt = result.scalar_one_or_none()
    if attempt:
        attempt.success = True
        attempt.session_id = session_id
        await db.flush()


async def get_attempts_today(db: AsyncSession, user_id: UUID) -> int:
    """Devuelve el número de intentos en las últimas 24h."""
    window_hours = getattr(settings, "kyc_attempt_window_hours", 24)
    window_start = datetime.now(tz=timezone.utc) - timedelta(hours=window_hours)
    return await db.scalar(
        select(func.count(KycAttempt.id)).where(
            and_(
                KycAttempt.user_id == user_id,
                KycAttempt.attempted_at >= window_start,
            )
        )
    ) or 0
