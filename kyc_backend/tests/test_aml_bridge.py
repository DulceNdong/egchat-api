"""
Tests del bridge AML → KYC: _aml_risk_contribution() y lógica de escalada.
Tests unitarios puros — sin BD (se mockea la capa de acceso a datos).
"""
import pytest
from app.services.aml_kyc_bridge import _aml_risk_contribution


# ── _aml_risk_contribution ────────────────────────────────────────

def test_no_flags_low_volume_returns_none():
    contrib = _aml_risk_contribution(
        flagged_count=0, flagged_types=[], volume=100_000, velocity_1h=2, ctr_count=0
    )
    assert contrib == "none"


def test_one_flag_returns_medium():
    contrib = _aml_risk_contribution(
        flagged_count=1, flagged_types=["MANUAL"], volume=100_000, velocity_1h=2, ctr_count=0
    )
    assert contrib == "medium"


def test_three_flags_returns_high():
    contrib = _aml_risk_contribution(
        flagged_count=3, flagged_types=["MANUAL", "VELOCITY", "STRUCTURING"],
        volume=100_000, velocity_1h=2, ctr_count=0
    )
    assert contrib == "high"


def test_sanctions_hit_returns_high():
    contrib = _aml_risk_contribution(
        flagged_count=1, flagged_types=["SANCTIONS_HIT"],
        volume=50_000, velocity_1h=2, ctr_count=0
    )
    assert contrib == "high"


def test_structuring_returns_high():
    contrib = _aml_risk_contribution(
        flagged_count=1, flagged_types=["STRUCTURING"],
        volume=50_000, velocity_1h=2, ctr_count=0
    )
    assert contrib == "high"


def test_high_velocity_returns_medium():
    contrib = _aml_risk_contribution(
        flagged_count=0, flagged_types=[], volume=100_000,
        velocity_1h=15,   # > 10 → medium
        ctr_count=0
    )
    assert contrib == "medium"


def test_ctr_triggered_returns_medium():
    contrib = _aml_risk_contribution(
        flagged_count=0, flagged_types=[], volume=100_000, velocity_1h=2,
        ctr_count=1   # CTR → medium
    )
    assert contrib == "medium"


def test_large_volume_no_flags_returns_low():
    contrib = _aml_risk_contribution(
        flagged_count=0, flagged_types=[], volume=3_000_000,   # > 2.5M → low
        velocity_1h=2, ctr_count=0
    )
    assert contrib == "low"


@pytest.mark.parametrize("flagged_types,expected", [
    (["THRESHOLD_BREACH"],  "medium"),   # flag pero no sanctions/structuring
    (["VELOCITY"],          "medium"),
    (["PEP_INVOLVED"],      "medium"),
    (["SANCTIONS_HIT"],     "high"),
    (["STRUCTURING"],       "high"),
])
def test_flag_type_contribution(flagged_types, expected):
    contrib = _aml_risk_contribution(
        flagged_count=1, flagged_types=flagged_types,
        volume=100_000, velocity_1h=2, ctr_count=0
    )
    assert contrib == expected
