"""
Servicio AML — lógica de detección automática de patrones sospechosos.

Detecta:
  THRESHOLD_BREACH  → transacción única > 5M XAF (CTR obligatorio CEMAC)
  STRUCTURING       → N transacciones < umbral en ventana de 24h
  VELOCITY          → demasiadas operaciones en poco tiempo
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.audit import log_action
from app.models.transaction import Transaction

logger = logging.getLogger("egchat.aml")
settings = get_settings()


async def auto_flag_transaction(db: AsyncSession, tx: Transaction) -> None:
    """
    Evalúa una transacción recién creada y la flaggea automáticamente
    si activa alguna regla AML. Llamar desde el hook post-insert de transacción
    o desde el endpoint de creación de transacción.
    """
    amount = float(tx.amount)
    now    = datetime.now(tz=timezone.utc)

    # ── Regla 1: Umbral CTR (≥5M XAF) ────────────────────────────
    if amount >= settings.aml_ctr_threshold_xaf:
        await _flag(db, tx, "THRESHOLD_BREACH",
                    f"Transacción supera umbral CTR: {amount:,.0f} XAF (límite {settings.aml_ctr_threshold_xaf:,})")
        return  # una sola regla por transacción

    # ── Regla 2: Estructuración ───────────────────────────────────
    window_start = now - timedelta(hours=settings.aml_structuring_window_hours)
    count_below = await db.scalar(
        select(func.count(Transaction.id))
        .where(and_(
            Transaction.user_id == tx.user_id,
            Transaction.amount < settings.aml_ctr_threshold_xaf,
            Transaction.created_at >= window_start,
            Transaction.id != tx.id,
        ))
    ) or 0

    if count_below >= settings.aml_structuring_count:
        total_in_window = await db.scalar(
            select(func.sum(Transaction.amount))
            .where(and_(
                Transaction.user_id == tx.user_id,
                Transaction.created_at >= window_start,
            ))
        ) or 0
        await _flag(db, tx, "STRUCTURING",
                    f"{count_below + 1} transacciones < umbral en {settings.aml_structuring_window_hours}h "
                    f"(total acumulado: {float(total_in_window):,.0f} XAF)")
        return

    # ── Regla 3: Velocidad (>10 operaciones en 1h) ────────────────
    one_hour_ago = now - timedelta(hours=1)
    hourly_count = await db.scalar(
        select(func.count(Transaction.id))
        .where(and_(
            Transaction.user_id == tx.user_id,
            Transaction.created_at >= one_hour_ago,
        ))
    ) or 0

    if hourly_count > 10:
        await _flag(db, tx, "VELOCITY",
                    f"{hourly_count} operaciones en la última hora")


async def _flag(db: AsyncSession, tx: Transaction, flag_type: str, reason: str) -> None:
    tx.flagged    = True
    tx.flag_type  = flag_type
    tx.flag_reason = reason
    tx.flagged_at  = datetime.now(tz=timezone.utc)
    await log_action(
        db, action="TX_AUTO_FLAGGED",
        user_id=tx.user_id,
        details={
            "transaction_id": str(tx.id),
            "amount": str(tx.amount),
            "currency": tx.currency,
            "flag_type": flag_type,
            "reason": reason,
        },
    )
    logger.warning("AML flag automático: %s tx=%s user=%s", flag_type, tx.id, tx.user_id)

    # ── Escalar KYC automáticamente si el contexto AML lo requiere ──
    import asyncio as _asyncio
    from app.services.aml_kyc_bridge import escalate_kyc_on_new_flag
    _asyncio.create_task(
        escalate_kyc_on_new_flag(db, tx.user_id, tx.id, flag_type)
    )
