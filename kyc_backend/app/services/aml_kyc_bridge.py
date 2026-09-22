"""
Bridge AML → KYC: extrae el contexto AML de las transacciones
del usuario y lo convierte en factores que alimentan el motor v2.

El orquestador ya llama _get_aml_context() directamente.
Este módulo expone funciones de más alto nivel para uso explícito
(p.ej. reevaluar el riesgo KYC cuando se flaggea una nueva transacción).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Transaction

logger = logging.getLogger("egchat.aml_kyc_bridge")

# Umbrales AML que disparan reevaluación del riesgo KYC
_THRESHOLD_FLAG_COUNT   = 1    # 1 tx flaggeada ya sube el riesgo
_THRESHOLD_VELOCITY_1H  = 10   # > 10 ops/hora = VELOCITY
_THRESHOLD_CTR_XAF      = 5_000_000  # ≥ 5M XAF = CTR (CEMAC)


async def get_aml_risk_context(
    db: AsyncSession,
    user_id: UUID,
    window_days: int = 30,
) -> dict:
    """
    Calcula el contexto AML completo de un usuario para alimentar
    RiskFactorsV2 del motor de decisión KYC.

    Devuelve:
      flagged_count       — total de transacciones flaggeadas
      flagged_types       — tipos de flag encontrados (STRUCTURING, etc.)
      volume_30d          — volumen total en los últimos window_days días
      count_30d           — número de transacciones en ventana
      velocity_1h         — operaciones en la última hora
      ctr_triggered       — alguna tx ≥ 5M XAF
      risk_contribution   — "none" | "low" | "medium" | "high"
    """
    now          = datetime.now(tz=timezone.utc)
    window_start = now - timedelta(days=window_days)
    one_hour_ago = now - timedelta(hours=1)

    # ── 1. Transacciones flaggeadas (todos los tiempos) ───────────
    flagged_res = await db.execute(
        select(
            func.count(Transaction.id).label("cnt"),
            func.array_agg(Transaction.flag_type.distinct()).label("types"),
        ).where(
            and_(
                Transaction.user_id == user_id,
                Transaction.flagged  == True,
            )
        )
    )
    flag_row  = flagged_res.one()
    flagged_count = int(flag_row.cnt or 0)
    flagged_types = [t for t in (flag_row.types or []) if t]

    # ── 2. Volumen + frecuencia en ventana ────────────────────────
    vol_res = await db.execute(
        select(
            func.coalesce(func.sum(Transaction.amount), 0).label("vol"),
            func.count(Transaction.id).label("cnt"),
        ).where(
            and_(
                Transaction.user_id    == user_id,
                Transaction.created_at >= window_start,
            )
        )
    )
    vol_row  = vol_res.one()
    volume   = float(vol_row.vol or 0)
    count_30 = int(vol_row.cnt or 0)

    # ── 3. Velocidad última hora ──────────────────────────────────
    velocity_res = await db.scalar(
        select(func.count(Transaction.id)).where(
            and_(
                Transaction.user_id    == user_id,
                Transaction.created_at >= one_hour_ago,
            )
        )
    ) or 0

    # ── 4. ¿Se disparó CTR? ───────────────────────────────────────
    ctr_res = await db.scalar(
        select(func.count(Transaction.id)).where(
            and_(
                Transaction.user_id    == user_id,
                Transaction.amount     >= _THRESHOLD_CTR_XAF,
                Transaction.created_at >= window_start,
            )
        )
    ) or 0

    # ── 5. Calcular contribución de riesgo AML al KYC ─────────────
    risk_contribution = _aml_risk_contribution(
        flagged_count, flagged_types, volume, velocity_res, ctr_res
    )

    return {
        "flagged_count":      flagged_count,
        "flagged_types":      flagged_types,
        "volume_30d":         volume,
        "count_30d":          count_30,
        "velocity_1h":        velocity_res,
        "ctr_triggered":      ctr_res > 0,
        "risk_contribution":  risk_contribution,
    }


async def should_trigger_kyc_review(
    db: AsyncSession,
    user_id: UUID,
) -> tuple[bool, str]:
    """
    Determina si un nuevo flag AML debe disparar una reevaluación
    del estado KYC del usuario (pasar de approved → pending).

    Devuelve (trigger: bool, reason: str).
    """
    ctx = await get_aml_risk_context(db, user_id)

    if ctx["risk_contribution"] in ("medium", "high"):
        reason = (
            f"AML re-evaluación: {ctx['flagged_count']} tx flaggeadas "
            f"({', '.join(ctx['flagged_types'])}), "
            f"volumen={ctx['volume_30d']:,.0f} XAF"
        )
        return True, reason

    return False, ""


async def escalate_kyc_on_new_flag(
    db: AsyncSession,
    user_id: UUID,
    transaction_id: UUID,
    flag_type: str,
) -> bool:
    """
    Llamar cuando se flaggea una transacción de un usuario con KYC aprobado.
    Si el contexto AML supera el umbral, re-escala la solicitud KYC a MANUAL_REVIEW.

    Devuelve True si se re-escaló, False si no fue necesario.
    """
    from sqlalchemy import update
    from app.models.kyc_application import KycApplication
    from app.core.audit import log_action

    trigger, reason = await should_trigger_kyc_review(db, user_id)
    if not trigger:
        return False

    # Buscar aplicación aprobada
    result = await db.execute(
        select(KycApplication).where(
            and_(
                KycApplication.user_id == user_id,
                KycApplication.status.in_(["approved", "APPROVED", "AUTO_APPROVED"]),
            )
        ).order_by(KycApplication.created_at.desc()).limit(1)
    )
    app = result.scalar_one_or_none()
    if not app:
        return False

    # Re-escalar a MANUAL_REVIEW para revisión humana
    app.status = "MANUAL_REVIEW"

    await log_action(
        db,
        action         = "KYC_AML_ESCALATION",
        application_id = app.id,
        user_id        = user_id,
        performed_role = "aml_system",
        details={
            "reason":         reason,
            "trigger_tx_id":  str(transaction_id),
            "flag_type":      flag_type,
        },
    )

    # Actualizar wallet_kyc_status
    from app.models.user import User
    user_res = await db.execute(select(User).where(User.id == user_id))
    user = user_res.scalar_one_or_none()
    if user:
        user.wallet_kyc_status = "pending"

    await db.commit()

    logger.warning(
        "KYC re-escalado por AML: user=%s app=%s flag=%s — %s",
        user_id, app.id, flag_type, reason,
    )
    return True


def _aml_risk_contribution(
    flagged_count: int,
    flagged_types: list[str],
    volume: float,
    velocity_1h: int,
    ctr_count: int,
) -> str:
    """
    Mapea el contexto AML a un nivel de contribución al riesgo KYC.
    none → no afecta
    low  → informativo
    medium → fuerza MANUAL_REVIEW
    high   → fuerza MANUAL_REVIEW + alerta
    """
    if (
        "SANCTIONS_HIT" in flagged_types
        or "STRUCTURING"  in flagged_types
        or flagged_count >= 3
    ):
        return "high"

    if (
        flagged_count >= _THRESHOLD_FLAG_COUNT
        or velocity_1h >= _THRESHOLD_VELOCITY_1H
        or ctr_count > 0
    ):
        return "medium"

    if volume >= _THRESHOLD_CTR_XAF * 0.5:   # > 2.5M XAF en 30d → informativo
        return "low"

    return "none"
