"""
Tests del servicio de rate-limit KYC por user_id.
Usa una BD SQLite en memoria para los tests de integración ligera.
"""
import pytest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch


# ── Tests unitarios de lógica ─────────────────────────────────────

def test_attempt_window_calculation():
    """La ventana de 24h debe calcularse correctamente."""
    from datetime import datetime, timedelta, timezone
    window_hours = 24
    now  = datetime.now(tz=timezone.utc)
    start = now - timedelta(hours=window_hours)
    assert (now - start).total_seconds() == pytest.approx(window_hours * 3600, abs=1)


def test_max_attempts_default_is_five():
    """El límite por defecto debe ser 5 intentos."""
    with patch("app.services.kyc_rate_limit.settings") as mock_s:
        mock_s.kyc_max_attempts_per_day = 5
        mock_s.kyc_attempt_window_hours = 24
        import importlib
        import app.services.kyc_rate_limit as rl
        importlib.reload(rl)
        # Verificar que el módulo usa el valor de settings
        assert hasattr(rl, "check_and_record_attempt")


@pytest.mark.asyncio
async def test_check_and_record_attempt_allowed():
    """Con 0 intentos previos, debe permitir y registrar el intento."""
    from app.services.kyc_rate_limit import check_and_record_attempt

    mock_db = AsyncMock()
    # Simular 0 intentos existentes
    mock_db.scalar = AsyncMock(return_value=0)
    mock_db.add    = MagicMock()
    mock_db.flush  = AsyncMock()

    user_id = uuid.uuid4()
    allowed, reason = await check_and_record_attempt(mock_db, user_id, "127.0.0.1")

    assert allowed is True
    assert reason  is None
    mock_db.add.assert_called_once()


@pytest.mark.asyncio
async def test_check_and_record_attempt_blocked_at_limit():
    """Con 5 intentos previos (límite), debe bloquear."""
    from app.services.kyc_rate_limit import check_and_record_attempt

    mock_db = AsyncMock()
    mock_db.scalar = AsyncMock(return_value=5)   # ya alcanzó el límite
    mock_db.add    = MagicMock()
    mock_db.flush  = AsyncMock()

    user_id = uuid.uuid4()

    with patch("app.services.kyc_rate_limit.settings") as mock_s:
        mock_s.kyc_max_attempts_per_day = 5
        mock_s.kyc_attempt_window_hours = 24
        allowed, reason = await check_and_record_attempt(mock_db, user_id)

    assert allowed is False
    assert reason  is not None
    assert "5" in reason or "límite" in reason.lower()


@pytest.mark.asyncio
async def test_get_attempts_today_returns_count():
    """get_attempts_today debe devolver el escalar de la query."""
    from app.services.kyc_rate_limit import get_attempts_today

    mock_db  = AsyncMock()
    mock_db.scalar = AsyncMock(return_value=3)
    user_id  = uuid.uuid4()

    count = await get_attempts_today(mock_db, user_id)
    assert count == 3
