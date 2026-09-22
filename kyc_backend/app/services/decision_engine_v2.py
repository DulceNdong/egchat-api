"""
Motor de decisión KYC v2 — Matriz de 6 factores COBAC R-2023/01.

Matriz de riesgo (cada factor puntúa 1, 2 o 3):

  Factor              1 (Bajo)            2 (Medio)          3 (Alto)
  ─────────────────── ─────────────────── ────────────────── ──────────────────
  Nacionalidad        GQ / CEMAC          Otra               Lista FATF
  Volumen mensual     < 500k XAF          500k–2M XAF        > 2M XAF
  Frecuencia/mes      < 10 ops            10–50 ops          > 50 ops
  Origen fondos       Salario / Pensión   Negocio / Ahorro   No verificable / Otro
  PEP                 No                  —                  Sí
  Canal               Presencial          Digital e-KYC      Digital incompleto

  Total < 8  → LOW    → AUTO_APPROVED  (si biometría y doc pasan)
  Total 8–12 → MEDIUM → MANUAL_REVIEW
  Total > 12 → HIGH   → MANUAL_REVIEW

Reglas de rechazo automático (independientes del score):
  sanctions_match  → REJECTED  (no reversible)
  doc_expired      → REJECTED
  ocr < 0.70       → MANUAL_REVIEW
  face < 0.80      → MANUAL_REVIEW
  liveness_failed  → MANUAL_REVIEW
  pep              → MANUAL_REVIEW  (obligatorio COBAC Art.12)
  has_flagged_txs  → MANUAL_REVIEW
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── Países CEMAC (unión monetaria, riesgo bajo) ───────────────────
CEMAC_COUNTRIES = {"GQ", "CM", "GA", "CG", "CF", "TD"}

# ── Países FATF alto riesgo (lista pública 2024) ──────────────────
FATF_HIGH_RISK = {
    # Blacklist FATF
    "AF", "IR", "KP", "MM", "SY", "YE",
    # Grey list relevante (actualizar cuando FATF publique cambios)
    "AL", "BB", "BF", "CM_HR", "CD", "GI", "HT", "JM", "JO",
    "ML", "MZ", "NG", "PA", "PH", "SN", "SS", "TZ", "TT",
    "UG", "VN", "VU",
}
# Nota: CM aparece en CEMAC (riesgo bajo) Y en grey list.
# Si la nacionalidad es CM usamos CEMAC como prioridad.

# ── Canales reconocidos ───────────────────────────────────────────
CHANNEL_SCORES = {
    "presencial":         1,
    "digital_ekyc":       2,   # e-KYC completo (todos los pasos)
    "digital_incomplete": 3,   # digital sin completar todos los pasos
}

# ── Origen de fondos ──────────────────────────────────────────────
SOF_SCORES = {
    "SALARY":     1,
    "PENSION":    1,
    "SAVINGS":    2,
    "BUSINESS":   2,
    "INVESTMENT": 2,
    "REMITTANCE": 2,
    "OTHER":      3,
    None:         3,   # no declarado = peor caso
}

# ── Umbrales de volumen mensual (XAF) ─────────────────────────────
_VOL_LOW    = 500_000
_VOL_MEDIUM = 2_000_000

# ── Umbrales de frecuencia mensual (operaciones) ─────────────────
_FREQ_LOW    = 10
_FREQ_MEDIUM = 50


@dataclass
class RiskFactorsV2:
    """Señales de riesgo recopiladas por el orquestador."""
    # ── Biometría / documento ─────────────────────────────────────
    ocr_confidence:   float      = 0.0
    face_match_score: float      = 0.0
    liveness_passed:  bool       = False
    doc_expired:      bool       = False

    # ── Screening ─────────────────────────────────────────────────
    sanctions_match:    bool = False
    pep_match:          bool = False
    politically_exposed:bool = False

    # ── Perfil COBAC (6 factores) ─────────────────────────────────
    nationality:           str        = "GQ"
    source_of_funds:       str | None = None
    monthly_income_range:  str | None = None   # usado como fallback si no hay volumen real
    channel:               str        = "digital_ekyc"

    # ── Contexto AML ─────────────────────────────────────────────
    has_flagged_txs:     bool  = False
    flagged_tx_count:    int   = 0
    tx_volume_xaf:       float = 0.0    # volumen últimos 30 días
    tx_frequency_month:  int   = 0      # operaciones últimos 30 días


@dataclass
class DecisionResultV2:
    risk_score:  int           # suma de factores COBAC (2–18)
    risk_level:  str           # low | medium | high
    decision:    str           # AUTO_APPROVED | MANUAL_REVIEW | REJECTED | BLOCKED
    factors:     list[str]     # explicación de cada factor aplicado
    biometry_ok: bool          # OCR + face + liveness pasaron
    doc_ok:      bool          # documento válido y no vencido


# ══════════════════════════════════════════════════════════════════
# Función principal
# ══════════════════════════════════════════════════════════════════

def calculate_risk_score_v2(f: RiskFactorsV2) -> DecisionResultV2:
    """
    Calcula el score COBAC de 6 factores y aplica las reglas de decisión.
    Devuelve DecisionResultV2.
    """
    factors: list[str] = []

    # ─────────────────────────────────────────────────────────────
    # PASO 0: Rechazos inmediatos (independientes del score)
    # ─────────────────────────────────────────────────────────────
    if f.sanctions_match:
        return DecisionResultV2(
            risk_score  = 18,
            risk_level  = "high",
            decision    = "REJECTED",
            factors     = ["SANCTIONS_MATCH — rechazo inmediato irreversible (COBAC Art.15)"],
            biometry_ok = False,
            doc_ok      = False,
        )

    if f.doc_expired:
        return DecisionResultV2(
            risk_score  = 18,
            risk_level  = "high",
            decision    = "REJECTED",
            factors     = ["DOC_EXPIRED — documento de identidad vencido"],
            biometry_ok = False,
            doc_ok      = False,
        )

    # ─────────────────────────────────────────────────────────────
    # PASO 1: Matriz de 6 factores COBAC
    # ─────────────────────────────────────────────────────────────

    # Factor 1 — Nacionalidad (1 | 2 | 3)
    nat = (f.nationality or "GQ").upper().strip()
    if nat in CEMAC_COUNTRIES:
        nat_score = 1
        factors.append(f"Nac=1 CEMAC ({nat})")
    elif nat in FATF_HIGH_RISK:
        nat_score = 3
        factors.append(f"Nac=3 FATF_HIGH_RISK ({nat})")
    else:
        nat_score = 2
        factors.append(f"Nac=2 OTRA ({nat})")

    # Factor 2 — Volumen mensual (1 | 2 | 3)
    volume = f.tx_volume_xaf
    if volume == 0 and f.monthly_income_range:
        # Fallback: estimar volumen desde el rango declarado
        volume = _estimate_volume_from_range(f.monthly_income_range)

    if volume < _VOL_LOW:
        vol_score = 1
        factors.append(f"Vol=1 <500k XAF ({volume:,.0f})")
    elif volume <= _VOL_MEDIUM:
        vol_score = 2
        factors.append(f"Vol=2 500k–2M XAF ({volume:,.0f})")
    else:
        vol_score = 3
        factors.append(f"Vol=3 >2M XAF ({volume:,.0f})")

    # Factor 3 — Frecuencia mensual (1 | 2 | 3)
    freq = f.tx_frequency_month
    if freq < _FREQ_LOW:
        freq_score = 1
        factors.append(f"Frec=1 <10 ops ({freq})")
    elif freq <= _FREQ_MEDIUM:
        freq_score = 2
        factors.append(f"Frec=2 10–50 ops ({freq})")
    else:
        freq_score = 3
        factors.append(f"Frec=3 >50 ops ({freq})")

    # Factor 4 — Origen de fondos (1 | 2 | 3)
    sof_score = SOF_SCORES.get((f.source_of_funds or "").upper(), 3)
    factors.append(f"SOF={sof_score} {f.source_of_funds or 'NO_DECLARADO'}")

    # Factor 5 — PEP (1 | 3)
    is_pep = f.pep_match or f.politically_exposed
    pep_score = 3 if is_pep else 1
    factors.append(f"PEP={pep_score} {'SÍ' if is_pep else 'NO'}")

    # Factor 6 — Canal (1 | 2 | 3)
    channel_key = (f.channel or "digital_ekyc").lower().strip()
    chan_score  = CHANNEL_SCORES.get(channel_key, 2)
    factors.append(f"Canal={chan_score} {channel_key}")

    total_score = nat_score + vol_score + freq_score + sof_score + pep_score + chan_score

    # ─────────────────────────────────────────────────────────────
    # PASO 2: Nivel de riesgo COBAC
    # ─────────────────────────────────────────────────────────────
    if total_score < 8:
        risk_level = "low"
    elif total_score <= 12:
        risk_level = "medium"
    else:
        risk_level = "high"

    # ─────────────────────────────────────────────────────────────
    # PASO 3: Checks de biometría y documento
    # ─────────────────────────────────────────────────────────────
    biometry_issues: list[str] = []

    if f.ocr_confidence < 0.70:
        biometry_issues.append(f"OCR_LOW ({f.ocr_confidence:.2f} < 0.70)")
    if f.face_match_score < 0.80:
        biometry_issues.append(f"FACE_LOW ({f.face_match_score:.2f} < 0.80)")
    if not f.liveness_passed:
        biometry_issues.append("LIVENESS_FAILED")
    if f.has_flagged_txs:
        biometry_issues.append(f"AML_FLAGS ({f.flagged_tx_count} tx)")

    biometry_ok = len(biometry_issues) == 0
    doc_ok      = not f.doc_expired and f.ocr_confidence >= 0.70

    if biometry_issues:
        factors.extend([f"⚠ {i}" for i in biometry_issues])

    # ─────────────────────────────────────────────────────────────
    # PASO 4: Decisión final
    # ─────────────────────────────────────────────────────────────
    #
    # AUTO_APPROVED solo si:
    #   - risk_level == LOW
    #   - todos los checks de biometría pasan
    #   - no hay PEP (COBAC obliga revisión manual)
    #
    if risk_level == "low" and biometry_ok and not is_pep:
        decision = "AUTO_APPROVED"
    else:
        decision = "MANUAL_REVIEW"

    factors.append(f"TOTAL={total_score} → {risk_level.upper()} → {decision}")

    return DecisionResultV2(
        risk_score  = total_score,
        risk_level  = risk_level,
        decision    = decision,
        factors     = factors,
        biometry_ok = biometry_ok,
        doc_ok      = doc_ok,
    )


def _estimate_volume_from_range(income_range: str) -> float:
    """Estima volumen mensual desde el rango declarado (fallback)."""
    mapping = {
        "UNDER_100K": 50_000,
        "100K_500K":  300_000,
        "500K_1M":    750_000,
        "1M_5M":      3_000_000,
        "OVER_5M":    6_000_000,
    }
    return float(mapping.get((income_range or "").upper(), 0))
