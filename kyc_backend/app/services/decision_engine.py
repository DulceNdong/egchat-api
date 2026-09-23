"""
Motor de decisión KYC — calcula risk_score y determina el flujo:
  AUTO_APPROVED  → score 0–30, sin matches de sanctions
  MANUAL_REVIEW  → score 31–100 o flags de riesgo
  BLOCKED        → match directo en lista SANCTIONS

Factores (ver spec kyc-aml-backend.md §3):
  +25 → SANCTIONS match
  +20 → PEP match o politically_exposed=True
  +10 → ADVERSE_MEDIA match
  +20 → liveness_passed = False
  +15 → ocr_confidence < 0.70
  +10 → face_match_score < 0.75
  +10 → source_of_funds = OTHER
  +10 → monthly_income_range = OVER_5M sin justificación
  +15 → Nacionalidad en lista FATF high-risk
  -10 → doc OCR confidence > 0.90 y liveness OK
  -5  → face_match_score > 0.90
"""
from __future__ import annotations
from dataclasses import dataclass, field

# Países FATF de alto riesgo (lista pública 2024)
FATF_HIGH_RISK = {
    "AF", "IR", "KP", "MM", "PK", "SY", "YE",  # blacklist
    "AL", "BB", "BF", "CM", "CD", "GI", "HT",  # grey list relevante
    "JM", "JO", "ML", "MZ", "NG", "PA", "PH",
    "SN", "SS", "TZ", "TT", "UG", "VN", "VU",
}


@dataclass
class RiskFactors:
    """Colección de señales de riesgo recogidas durante el proceso KYC."""
    sanctions_match: bool   = False
    pep_match: bool         = False
    adverse_media_match: bool = False
    politically_exposed: bool = False
    liveness_passed: bool | None = None
    ocr_confidence: float | None = None
    face_match_score: float | None = None
    source_of_funds: str | None  = None
    monthly_income_range: str | None = None
    nationality: str = "GQ"
    factors_applied: list[str] = field(default_factory=list)


@dataclass
class DecisionResult:
    risk_score: int
    risk_level: str          # low | medium | high
    decision: str            # AUTO_APPROVED | MANUAL_REVIEW | BLOCKED
    factors: list[str]       # descripción de cada factor aplicado


def calculate_risk_score(f: RiskFactors) -> DecisionResult:
    """
    Calcula el score de riesgo (0–100) y devuelve la decisión.
    """
    score = 0
    factors: list[str] = []

    # ── Bloqueo inmediato ─────────────────────────────────────────
    if f.sanctions_match:
        return DecisionResult(
            risk_score=100,
            risk_level="high",
            decision="BLOCKED",
            factors=["SANCTIONS_MATCH — bloqueo inmediato (COBAC Art.15)"],
        )

    # ── Factores incrementales ────────────────────────────────────
    if f.pep_match or f.politically_exposed:
        score += 20
        factors.append(f"+20 PEP{'_MATCH' if f.pep_match else '_DECLARED'}")

    if f.adverse_media_match:
        score += 10
        factors.append("+10 ADVERSE_MEDIA_MATCH")

    if f.nationality.upper() in FATF_HIGH_RISK:
        score += 15
        factors.append(f"+15 FATF_HIGH_RISK_COUNTRY ({f.nationality})")

    if f.liveness_passed is False:
        score += 20
        factors.append("+20 LIVENESS_FAILED")

    if f.ocr_confidence is not None and f.ocr_confidence < 0.70:
        score += 15
        factors.append(f"+15 OCR_LOW_CONFIDENCE ({f.ocr_confidence:.2f})")

    if f.face_match_score is not None and f.face_match_score < 0.75:
        score += 10
        factors.append(f"+10 FACE_MATCH_LOW ({f.face_match_score:.2f})")

    if f.source_of_funds == "OTHER":
        score += 10
        factors.append("+10 SOURCE_OF_FUNDS_OTHER")

    if f.monthly_income_range == "OVER_5M":
        score += 10
        factors.append("+10 INCOME_OVER_5M_XAF")

    # ── Factores reductores ───────────────────────────────────────
    if (f.ocr_confidence is not None and f.ocr_confidence > 0.90
            and f.liveness_passed is True):
        score -= 10
        factors.append("-10 HIGH_OCR_CONF + LIVENESS_OK")

    if f.face_match_score is not None and f.face_match_score > 0.90:
        score -= 5
        factors.append(f"-5 FACE_MATCH_HIGH ({f.face_match_score:.2f})")

    # Clamp 0–100
    score = max(0, min(100, score))

    # ── Nivel de riesgo ───────────────────────────────────────────
    if score <= 20:
        risk_level = "low"
    elif score <= 55:
        risk_level = "medium"
    else:
        risk_level = "high"

    # ── Decisión ──────────────────────────────────────────────────
    if score <= 30 and f.liveness_passed is not False:
        decision = "AUTO_APPROVED"
    else:
        decision = "MANUAL_REVIEW"

    return DecisionResult(
        risk_score=score,
        risk_level=risk_level,
        decision=decision,
        factors=factors,
    )
