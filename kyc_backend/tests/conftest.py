"""
Configuración global de pytest para el backend KYC/AML.

Fixtures disponibles para todos los tests:
  - low_risk_factors    → RiskFactorsV2 que produce AUTO_APPROVED
  - medium_risk_factors → RiskFactorsV2 que produce MANUAL_REVIEW (score 8-12)
  - high_risk_factors   → RiskFactorsV2 que produce MANUAL_REVIEW (score >12)
  - sanctions_factors   → RiskFactorsV2 con sanctions_match=True → REJECTED
  - stub_provider       → StubKYCProvider con resultados OK
  - stub_bad_ocr        → StubKYCProvider con OCR bajo
  - stub_bad_face       → StubKYCProvider con face match bajo
  - stub_liveness_fail  → StubKYCProvider con liveness fallido
  - stub_expired_doc    → StubKYCProvider con documento vencido
"""
import pytest
from app.services.decision_engine_v2 import RiskFactorsV2
from app.services.kyc_provider import StubKYCProvider


# ── Fixtures de RiskFactorsV2 ─────────────────────────────────────

@pytest.fixture
def low_risk_factors():
    """Score esperado: 1+1+1+1+1+2 = 7 → LOW → AUTO_APPROVED (biometría OK)."""
    return RiskFactorsV2(
        ocr_confidence       = 0.92,
        face_match_score     = 0.91,
        liveness_passed      = True,
        doc_expired          = False,
        sanctions_match      = False,
        pep_match            = False,
        politically_exposed  = False,
        nationality          = "GQ",           # CEMAC → 1
        source_of_funds      = "SALARY",       # → 1
        monthly_income_range = "UNDER_100K",
        channel              = "digital_ekyc", # → 2
        has_flagged_txs      = False,
        tx_volume_xaf        = 100_000,        # < 500k → 1
        tx_frequency_month   = 5,              # < 10   → 1
    )


@pytest.fixture
def medium_risk_factors():
    """Score esperado: 2+2+2+2+1+2 = 11 → MEDIUM → MANUAL_REVIEW."""
    return RiskFactorsV2(
        ocr_confidence       = 0.92,
        face_match_score     = 0.91,
        liveness_passed      = True,
        doc_expired          = False,
        sanctions_match      = False,
        pep_match            = False,
        politically_exposed  = False,
        nationality          = "NG",           # Otra → 2
        source_of_funds      = "BUSINESS",     # → 2
        monthly_income_range = "500K_1M",
        channel              = "digital_ekyc", # → 2
        has_flagged_txs      = False,
        tx_volume_xaf        = 800_000,        # 500k-2M → 2
        tx_frequency_month   = 25,             # 10-50   → 2
    )


@pytest.fixture
def high_risk_factors():
    """Score esperado: 3+3+3+3+3+3 = 18 → HIGH → MANUAL_REVIEW."""
    return RiskFactorsV2(
        ocr_confidence       = 0.92,
        face_match_score     = 0.91,
        liveness_passed      = True,
        doc_expired          = False,
        sanctions_match      = False,
        pep_match            = True,           # PEP → 3
        politically_exposed  = True,
        nationality          = "IR",           # FATF blacklist → 3
        source_of_funds      = "OTHER",        # → 3
        monthly_income_range = "OVER_5M",
        channel              = "digital_incomplete",  # → 3
        has_flagged_txs      = True,
        tx_volume_xaf        = 3_000_000,      # > 2M → 3
        tx_frequency_month   = 60,             # > 50  → 3
    )


@pytest.fixture
def sanctions_factors():
    """sanctions_match=True → REJECTED inmediato."""
    return RiskFactorsV2(
        sanctions_match  = True,
        nationality      = "GQ",
        liveness_passed  = True,
        ocr_confidence   = 0.95,
        face_match_score = 0.95,
    )


@pytest.fixture
def expired_doc_factors():
    """doc_expired=True → REJECTED inmediato."""
    return RiskFactorsV2(
        doc_expired      = True,
        nationality      = "GQ",
        liveness_passed  = True,
        ocr_confidence   = 0.95,
        face_match_score = 0.95,
    )


@pytest.fixture
def pep_factors():
    """PEP=True con LOW score → sigue siendo MANUAL_REVIEW (obligatorio COBAC)."""
    return RiskFactorsV2(
        ocr_confidence      = 0.92,
        face_match_score    = 0.91,
        liveness_passed     = True,
        doc_expired         = False,
        sanctions_match     = False,
        pep_match           = True,        # PEP → siempre MANUAL_REVIEW
        politically_exposed = True,
        nationality         = "GQ",        # CEMAC → 1
        source_of_funds     = "SALARY",    # → 1
        channel             = "digital_ekyc",
        tx_volume_xaf       = 50_000,
        tx_frequency_month  = 2,
    )


# ── Fixtures de StubKYCProvider ───────────────────────────────────

@pytest.fixture
def stub_provider():
    """Proveedor stub con todos los checks OK."""
    return StubKYCProvider()


@pytest.fixture
def stub_bad_ocr():
    """Proveedor stub con OCR confidence 0.45 (< 0.70)."""
    return StubKYCProvider(force_bad_ocr=True)


@pytest.fixture
def stub_bad_face():
    """Proveedor stub con face_match 0.55 (< 0.80)."""
    return StubKYCProvider(force_bad_face=True)


@pytest.fixture
def stub_liveness_fail():
    """Proveedor stub con liveness=False."""
    return StubKYCProvider(force_liveness_fail=True)


@pytest.fixture
def stub_expired_doc():
    """Proveedor stub con documento vencido."""
    return StubKYCProvider(force_expired=True)
