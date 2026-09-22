"""
Tests del motor de decisión KYC v2 — calculate_risk_score_v2().

Cubre:
  - Rechazos inmediatos (sanctions, doc_expired)
  - Matriz de 6 factores COBAC
  - Umbrales LOW/MEDIUM/HIGH
  - Regla PEP obligatoria (siempre MANUAL_REVIEW)
  - Fallback de volumen desde income_range
  - Casos de biometría degradada
  - Canales correctos
"""
import pytest
from app.services.decision_engine_v2 import (
    RiskFactorsV2,
    calculate_risk_score_v2,
    CEMAC_COUNTRIES,
    FATF_HIGH_RISK,
    _estimate_volume_from_range,
)


# ══════════════════════════════════════════════════════════════════
# Rechazos inmediatos
# ══════════════════════════════════════════════════════════════════

def test_sanctions_match_rejected_immediately(sanctions_factors):
    result = calculate_risk_score_v2(sanctions_factors)
    assert result.decision   == "REJECTED"
    assert result.risk_level == "high"
    assert result.risk_score == 18
    assert any("SANCTIONS" in f for f in result.factors)


def test_expired_doc_rejected_immediately(expired_doc_factors):
    result = calculate_risk_score_v2(expired_doc_factors)
    assert result.decision   == "REJECTED"
    assert result.doc_ok     is False
    assert any("EXPIRED" in f for f in result.factors)


def test_sanctions_takes_priority_over_pep():
    """Sanctions + PEP → REJECTED (no MANUAL_REVIEW)."""
    f = RiskFactorsV2(
        sanctions_match     = True,
        pep_match           = True,
        politically_exposed = True,
        nationality         = "IR",
    )
    result = calculate_risk_score_v2(f)
    assert result.decision == "REJECTED"


# ══════════════════════════════════════════════════════════════════
# Casos AUTO_APPROVED
# ══════════════════════════════════════════════════════════════════

def test_low_risk_auto_approved(low_risk_factors):
    result = calculate_risk_score_v2(low_risk_factors)
    assert result.decision    == "AUTO_APPROVED"
    assert result.risk_level  == "low"
    assert result.risk_score  < 8
    assert result.biometry_ok is True
    assert result.doc_ok      is True


def test_all_cemac_factors_minimum_score():
    """Todos los factores al mínimo → score 6 → LOW → AUTO_APPROVED."""
    f = RiskFactorsV2(
        ocr_confidence      = 0.95,
        face_match_score    = 0.95,
        liveness_passed     = True,
        doc_expired         = False,
        sanctions_match     = False,
        pep_match           = False,
        politically_exposed = False,
        nationality         = "GQ",            # CEMAC → 1
        source_of_funds     = "SALARY",        # → 1
        channel             = "presencial",    # → 1
        tx_volume_xaf       = 10_000,          # < 500k → 1
        tx_frequency_month  = 2,               # < 10   → 1
    )
    result = calculate_risk_score_v2(f)
    # nat=1, vol=1, freq=1, sof=1, pep=1, canal=1 → total=6
    assert result.risk_score == 6
    assert result.decision   == "AUTO_APPROVED"


def test_gabonese_user_auto_approved():
    """Gabón es CEMAC — riesgo bajo por nacionalidad."""
    f = RiskFactorsV2(
        ocr_confidence   = 0.91,
        face_match_score = 0.88,
        liveness_passed  = True,
        nationality      = "GA",           # CEMAC
        source_of_funds  = "SALARY",
        channel          = "digital_ekyc",
        tx_volume_xaf    = 200_000,
        tx_frequency_month = 4,
    )
    result = calculate_risk_score_v2(f)
    assert result.risk_level == "low"
    assert result.decision   == "AUTO_APPROVED"


# ══════════════════════════════════════════════════════════════════
# Casos MANUAL_REVIEW por score
# ══════════════════════════════════════════════════════════════════

def test_medium_risk_manual_review(medium_risk_factors):
    result = calculate_risk_score_v2(medium_risk_factors)
    assert result.decision   == "MANUAL_REVIEW"
    assert result.risk_level == "medium"
    assert 8 <= result.risk_score <= 12


def test_high_risk_manual_review(high_risk_factors):
    result = calculate_risk_score_v2(high_risk_factors)
    assert result.decision   == "MANUAL_REVIEW"
    assert result.risk_level == "high"
    assert result.risk_score  > 12


def test_fatf_country_increases_score():
    """Nacionalidad FATF (Irán) sube el factor de nacionalidad a 3."""
    base = RiskFactorsV2(
        ocr_confidence   = 0.92, face_match_score=0.91, liveness_passed=True,
        nationality      = "IR",   # FATF blacklist
        source_of_funds  = "SALARY", channel="digital_ekyc",
        tx_volume_xaf=50_000, tx_frequency_month=2,
    )
    result = calculate_risk_score_v2(base)
    # nat=3 fuerza score ≥ 8 (si los demás son 1)
    # 3+1+1+1+1+2=9 → medium
    assert result.risk_score >= 8
    assert result.decision == "MANUAL_REVIEW"
    assert any("FATF" in f for f in result.factors)


def test_other_nationality_medium_score():
    """Nacionalidad fuera de CEMAC y FATF → factor 2."""
    f = RiskFactorsV2(
        ocr_confidence   = 0.92, face_match_score=0.91, liveness_passed=True,
        nationality      = "FR",   # Francia, no CEMAC ni FATF
        source_of_funds  = "SALARY", channel="digital_ekyc",
        tx_volume_xaf=50_000, tx_frequency_month=2,
    )
    result = calculate_risk_score_v2(f)
    assert any("Nac=2" in f for f in result.factors)


# ══════════════════════════════════════════════════════════════════
# Regla PEP obligatoria
# ══════════════════════════════════════════════════════════════════

def test_pep_always_manual_review(pep_factors):
    """PEP con biometría perfecta y score LOW → sigue siendo MANUAL_REVIEW (COBAC)."""
    result = calculate_risk_score_v2(pep_factors)
    assert result.decision == "MANUAL_REVIEW"
    assert any("PEP=3" in f for f in result.factors)


def test_pep_via_politically_exposed():
    """politically_exposed=True (aunque pep_match=False) → MANUAL_REVIEW."""
    f = RiskFactorsV2(
        ocr_confidence      = 0.95,
        face_match_score    = 0.95,
        liveness_passed     = True,
        politically_exposed = True,   # declarado por el usuario
        pep_match           = False,  # sin match en lista PEP
        nationality         = "GQ",
        source_of_funds     = "SALARY",
        channel             = "digital_ekyc",
        tx_volume_xaf       = 50_000,
        tx_frequency_month  = 2,
    )
    result = calculate_risk_score_v2(f)
    assert result.decision == "MANUAL_REVIEW"


# ══════════════════════════════════════════════════════════════════
# Biometría degradada
# ══════════════════════════════════════════════════════════════════

def test_low_ocr_forces_manual_review():
    f = RiskFactorsV2(
        ocr_confidence   = 0.55,   # < 0.70 → biometry_fail
        face_match_score = 0.95,
        liveness_passed  = True,
        nationality      = "GQ",
        source_of_funds  = "SALARY",
        channel          = "digital_ekyc",
        tx_volume_xaf    = 50_000,
        tx_frequency_month = 2,
    )
    result = calculate_risk_score_v2(f)
    assert result.decision    == "MANUAL_REVIEW"
    assert result.biometry_ok is False
    assert any("OCR_LOW" in f for f in result.factors)


def test_low_face_match_forces_manual_review():
    f = RiskFactorsV2(
        ocr_confidence   = 0.92,
        face_match_score = 0.65,   # < 0.80 → biometry_fail
        liveness_passed  = True,
        nationality      = "GQ",
        source_of_funds  = "SALARY",
        channel          = "digital_ekyc",
        tx_volume_xaf    = 50_000,
        tx_frequency_month = 2,
    )
    result = calculate_risk_score_v2(f)
    assert result.decision    == "MANUAL_REVIEW"
    assert result.biometry_ok is False
    assert any("FACE_LOW" in f for f in result.factors)


def test_liveness_fail_forces_manual_review():
    f = RiskFactorsV2(
        ocr_confidence   = 0.92,
        face_match_score = 0.91,
        liveness_passed  = False,   # → biometry_fail
        nationality      = "GQ",
        source_of_funds  = "SALARY",
        channel          = "digital_ekyc",
        tx_volume_xaf    = 50_000,
        tx_frequency_month = 2,
    )
    result = calculate_risk_score_v2(f)
    assert result.decision    == "MANUAL_REVIEW"
    assert result.biometry_ok is False
    assert any("LIVENESS_FAILED" in f for f in result.factors)


# ══════════════════════════════════════════════════════════════════
# Flags AML
# ══════════════════════════════════════════════════════════════════

def test_aml_flags_force_manual_review():
    """Con transacciones flaggeadas, incluso LOW score → MANUAL_REVIEW."""
    f = RiskFactorsV2(
        ocr_confidence   = 0.95,
        face_match_score = 0.95,
        liveness_passed  = True,
        nationality      = "GQ",
        source_of_funds  = "SALARY",
        channel          = "digital_ekyc",
        has_flagged_txs  = True,       # AML flag activo
        flagged_tx_count = 2,
        tx_volume_xaf    = 100_000,
        tx_frequency_month = 3,
    )
    result = calculate_risk_score_v2(f)
    assert result.decision    == "MANUAL_REVIEW"
    assert result.biometry_ok is False
    assert any("AML_FLAGS" in f for f in result.factors)


# ══════════════════════════════════════════════════════════════════
# Factores individuales
# ══════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("volume,expected_score", [
    (50_000,      1),   # < 500k
    (499_999,     1),
    (500_000,     2),   # 500k–2M
    (1_500_000,   2),
    (2_000_000,   2),
    (2_000_001,   3),   # > 2M
    (10_000_000,  3),
])
def test_volume_factor(volume, expected_score):
    f = RiskFactorsV2(
        ocr_confidence   = 0.92, face_match_score=0.91, liveness_passed=True,
        nationality      = "GQ", source_of_funds="SALARY",
        channel          = "presencial",
        tx_volume_xaf    = volume,
        tx_frequency_month = 5,
    )
    result = calculate_risk_score_v2(f)
    assert any(f"Vol={expected_score}" in factor for factor in result.factors), \
        f"Volumen {volume} debería dar Vol={expected_score}, factores: {result.factors}"


@pytest.mark.parametrize("freq,expected_score", [
    (0,   1), (9,   1),   # < 10
    (10,  2), (50,  2),   # 10–50
    (51,  3), (100, 3),   # > 50
])
def test_frequency_factor(freq, expected_score):
    f = RiskFactorsV2(
        ocr_confidence   = 0.92, face_match_score=0.91, liveness_passed=True,
        nationality      = "GQ", source_of_funds="SALARY",
        channel          = "presencial",
        tx_volume_xaf    = 100_000,
        tx_frequency_month = freq,
    )
    result = calculate_risk_score_v2(f)
    assert any(f"Frec={expected_score}" in factor for factor in result.factors)


@pytest.mark.parametrize("sof,expected_score", [
    ("SALARY",     1),
    ("PENSION",    1),
    ("SAVINGS",    2),
    ("BUSINESS",   2),
    ("INVESTMENT", 2),
    ("REMITTANCE", 2),
    ("OTHER",      3),
    (None,         3),
])
def test_source_of_funds_factor(sof, expected_score):
    f = RiskFactorsV2(
        ocr_confidence   = 0.92, face_match_score=0.91, liveness_passed=True,
        nationality      = "GQ", source_of_funds=sof,
        channel          = "presencial",
        tx_volume_xaf    = 100_000, tx_frequency_month=5,
    )
    result = calculate_risk_score_v2(f)
    assert any(f"SOF={expected_score}" in factor for factor in result.factors)


@pytest.mark.parametrize("channel,expected_score", [
    ("presencial",          1),
    ("digital_ekyc",        2),
    ("digital_incomplete",  3),
    ("unknown_channel",     2),   # fallback a 2
])
def test_channel_factor(channel, expected_score):
    f = RiskFactorsV2(
        ocr_confidence   = 0.92, face_match_score=0.91, liveness_passed=True,
        nationality      = "GQ", source_of_funds="SALARY",
        channel          = channel,
        tx_volume_xaf    = 100_000, tx_frequency_month=5,
    )
    result = calculate_risk_score_v2(f)
    assert any(f"Canal={expected_score}" in factor for factor in result.factors)


# ══════════════════════════════════════════════════════════════════
# Fallback volumen desde income_range
# ══════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("income_range,expected_vol_score", [
    ("UNDER_100K", 1),   # 50k < 500k
    ("100K_500K",  1),   # 300k < 500k
    ("500K_1M",    2),   # 750k ∈ [500k,2M]
    ("1M_5M",      3),   # 3M > 2M
    ("OVER_5M",    3),   # 6M > 2M
])
def test_volume_fallback_from_income_range(income_range, expected_vol_score):
    f = RiskFactorsV2(
        ocr_confidence       = 0.92,
        face_match_score     = 0.91,
        liveness_passed      = True,
        nationality          = "GQ",
        source_of_funds      = "SALARY",
        channel              = "presencial",
        monthly_income_range = income_range,
        tx_volume_xaf        = 0,   # sin historial real → usar fallback
        tx_frequency_month   = 5,
    )
    result = calculate_risk_score_v2(f)
    assert any(f"Vol={expected_vol_score}" in factor for factor in result.factors), \
        f"income_range={income_range} debería dar Vol={expected_vol_score}, factores: {result.factors}"


# ══════════════════════════════════════════════════════════════════
# Sets de países
# ══════════════════════════════════════════════════════════════════

def test_all_cemac_countries_in_set():
    assert all(c in CEMAC_COUNTRIES for c in ["GQ", "CM", "GA", "CG", "CF", "TD"])


def test_cemac_not_in_fatf():
    """GQ y GA no deben estar en FATF (prioridad CEMAC)."""
    assert "GQ" not in FATF_HIGH_RISK
    assert "GA" not in FATF_HIGH_RISK


def test_iran_in_fatf():
    assert "IR" in FATF_HIGH_RISK


def test_north_korea_in_fatf():
    assert "KP" in FATF_HIGH_RISK


# ══════════════════════════════════════════════════════════════════
# _estimate_volume_from_range
# ══════════════════════════════════════════════════════════════════

def test_estimate_volume_unknown_range():
    assert _estimate_volume_from_range("INVALID") == 0.0
    assert _estimate_volume_from_range(None) == 0.0


def test_estimate_volume_over_5m():
    assert _estimate_volume_from_range("OVER_5M") == 6_000_000.0
