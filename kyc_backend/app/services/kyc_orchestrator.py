"""
Orquestador KYC — pipeline completo de verificación.

Flujo al llamar run_verification_pipeline():
  1. Recuperar imágenes cifradas del storage
  2. KYCProvider: OCR + biometría + liveness (paralelo donde sea posible)
  3. ScreeningProvider: SANCTIONS + PEP (paralelo)
  4. Consultar contexto AML (flags en transacciones)
  5. Motor de decisión v2 (6 factores COBAC)
  6. Aplicar decisión: AUTO_APPROVED | MANUAL_REVIEW | REJECTED | BLOCKED
  7. Persistir resultados en kyc_documents + kyc_screening_results
  8. Actualizar users.wallet_kyc_status
  9. Notificar BANGE si corresponde
 10. Audit log

Devuelve: (decision, kyc_status, risk_score, risk_level)
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_action
from app.core.encryption import decrypt_if_present, encrypt_if_present
from app.models.kyc_application import KycApplication
from app.models.kyc_document import KycDocument
from app.models.kyc_personal_data import KycPersonalData
from app.models.kyc_screening import KycScreeningResult
from app.models.transaction import Transaction
from app.models.user import User
from app.services.decision_engine_v2 import (
    RiskFactorsV2,
    calculate_risk_score_v2,
    DecisionResultV2,
)
from app.services.kyc_provider import (
    DocumentData,
    KYCProvider,
    KYCProviderError,
    LivenessResult,
    get_kyc_provider,
)
from app.services.notifications import notify_user_kyc_decision
from app.services.screening import ScreeningMatch, run_full_screening

logger = logging.getLogger("egchat.kyc.orchestrator")

# Timeouts individuales por etapa (segundos)
_T_OCR       = 15
_T_BIOMETRY  = 15
_T_LIVENESS  = 10
_T_SCREENING = 15


# ══════════════════════════════════════════════════════════════════
# Punto de entrada principal
# ══════════════════════════════════════════════════════════════════

async def run_verification_pipeline(
    db:         AsyncSession,
    app:        KycApplication,
    user:       User,
    ip_address: str,
) -> tuple[str, str, int, str]:
    """
    Ejecuta el pipeline completo.
    Devuelve (decision, kyc_status_for_user, risk_score, risk_level).
    """
    now = datetime.now(tz=timezone.utc)
    session_id = app.session_id

    logger.info("Pipeline KYC iniciado: user=%s session=%s", user.id, session_id)

    # ── 1. Obtener bytes de documentos del storage ────────────────
    doc_bytes, selfie_bytes = await _fetch_document_bytes(db, user.id, app)

    # ── 2. Ejecución OCR + biometría + liveness ───────────────────
    provider: KYCProvider = get_kyc_provider()
    ocr_data, face_score, liveness = await _run_provider(
        provider, doc_bytes, selfie_bytes
    )

    # ── 3. Screening SANCTIONS + PEP ─────────────────────────────
    full_name  = (ocr_data.full_name or app.full_name or "").strip()
    birth_date = ocr_data.birth_date or (
        app.birth_date.date().isoformat() if app.birth_date else None
    )
    nationality = ocr_data.nationality or app.nationality or "GQ"

    screening = await _run_screening_with_timeout(
        db, app, full_name, birth_date, nationality
    )

    # ── 4. Contexto AML (flags en transacciones) ──────────────────
    aml_ctx = await _get_aml_context(db, user.id)

    # ── 5. Obtener datos del perfil financiero ────────────────────
    pd = await _get_personal_data(db, app.id)
    channel = (app.device_info or {}).get("channel", "digital_ekyc")

    # ── 6. Motor de decisión v2 ───────────────────────────────────
    factors = RiskFactorsV2(
        # Factores biométricos
        ocr_confidence   = ocr_data.confidence,
        face_match_score = face_score,
        liveness_passed  = liveness.passed,
        doc_expired      = ocr_data.expired,
        # Screening
        sanctions_match  = screening["SANCTIONS"].found,
        pep_match        = screening["PEP"].found,
        politically_exposed = (pd.politically_exposed if pd else False),
        # Perfil COBAC
        nationality      = nationality,
        source_of_funds  = (pd.source_of_funds if pd else None),
        monthly_income_range = (pd.monthly_income_range if pd else None),
        channel          = channel,
        # AML
        has_flagged_txs  = aml_ctx["flagged_count"] > 0,
        flagged_tx_count = aml_ctx["flagged_count"],
        tx_volume_xaf    = aml_ctx["volume_30d"],
        tx_frequency_month = aml_ctx["count_30d"],
    )

    result: DecisionResultV2 = calculate_risk_score_v2(factors)

    # ── 7. Persistir métricas en kyc_documents ────────────────────
    await _persist_doc_metrics(db, app, user.id, ocr_data, face_score, liveness)

    # ── 8. Actualizar kyc_application ─────────────────────────────
    app.status       = result.decision
    app.risk_score   = result.risk_score
    app.risk_level   = result.risk_level
    app.submitted_at = now
    app.doc_number   = ocr_data.doc_number or app.doc_number
    app.full_name    = full_name or app.full_name

    # ── 9. Actualizar users.wallet_kyc_status ─────────────────────
    kyc_status_for_user = _apply_user_status(user, result.decision, now)

    # ── 10. Audit log ─────────────────────────────────────────────
    await log_action(
        db,
        action=f"KYC_PIPELINE_{result.decision}",
        application_id=app.id,
        user_id=user.id,
        ip_address=ip_address,
        details={
            "decision":        result.decision,
            "risk_score":      result.risk_score,
            "risk_level":      result.risk_level,
            "factors":         result.factors,
            "ocr_confidence":  ocr_data.confidence,
            "face_match":      face_score,
            "liveness":        liveness.passed,
            "doc_expired":     ocr_data.expired,
            "sanctions":       screening["SANCTIONS"].found,
            "pep":             screening["PEP"].found,
            "aml_flags":       aml_ctx["flagged_count"],
            "provider":        provider.__class__.__name__,
        },
    )

    await db.commit()

    # ── 11. Notificar BANGE ───────────────────────────────────────
    asyncio.create_task(
        _notify_bange(result.decision, str(app.id), result.risk_score)
    )

    # ── 12. Notificar usuario ─────────────────────────────────────
    asyncio.create_task(
        notify_user_kyc_decision(str(user.id), result.decision)
    )

    logger.info(
        "Pipeline KYC completo: user=%s session=%s decision=%s score=%d",
        user.id, session_id, result.decision, result.risk_score,
    )
    return result.decision, kyc_status_for_user, result.risk_score, result.risk_level


# ══════════════════════════════════════════════════════════════════
# Helpers privados
# ══════════════════════════════════════════════════════════════════

async def _fetch_document_bytes(
    db: AsyncSession,
    user_id: UUID,
    app: KycApplication,
) -> tuple[bytes, bytes]:
    """
    Descarga las imágenes desde Supabase Storage usando las URLs cifradas.
    Devuelve (doc_bytes, selfie_bytes).
    Si no hay imágenes disponibles, devuelve bytes vacíos (el proveedor manejará el error).
    """
    # Buscar último documento del usuario
    doc_res = await db.execute(
        select(KycDocument)
        .where(
            and_(
                KycDocument.user_id == user_id,
                KycDocument.doc_type.in_(["doc_front", "document"]),
            )
        )
        .order_by(KycDocument.created_at.desc())
        .limit(1)
    )
    doc_record = doc_res.scalar_one_or_none()

    selfie_res = await db.execute(
        select(KycDocument)
        .where(
            and_(
                KycDocument.user_id == user_id,
                KycDocument.doc_type == "selfie",
            )
        )
        .order_by(KycDocument.created_at.desc())
        .limit(1)
    )
    selfie_record = selfie_res.scalar_one_or_none()

    doc_bytes    = await _download_from_url(doc_record, "front_image_url") if doc_record else b""
    selfie_bytes = await _download_from_url(selfie_record, "selfie_url") if selfie_record else b""

    return doc_bytes, selfie_bytes


async def _download_from_url(record: KycDocument, url_field: str) -> bytes:
    """Descifra la URL y descarga el archivo."""
    encrypted_url = getattr(record, url_field, None) or record.file_url
    if not encrypted_url:
        return b""
    try:
        url = decrypt_if_present(encrypted_url)
        if not url:
            return b""
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url)
            if r.is_success:
                return r.content
    except Exception as e:
        logger.warning("Error descargando documento: %s", e)
    return b""


async def _run_provider(
    provider: KYCProvider,
    doc_bytes: bytes,
    selfie_bytes: bytes,
) -> tuple[DocumentData, float, LivenessResult]:
    """
    Ejecuta OCR + biometría + liveness con timeouts individuales.
    En caso de error por proveedor, usa valores conservadores
    que fuerzan MANUAL_REVIEW (no bloquean el flujo).
    """
    from app.services.kyc_provider import DocumentData, LivenessResult

    _fallback_doc = DocumentData(confidence=0.0, expired=False,
                                  raw={"error": "provider_timeout"})
    _fallback_liveness = LivenessResult(passed=False, score=0.0,
                                         reason="PROVIDER_TIMEOUT")

    async def _safe_ocr() -> DocumentData:
        if not doc_bytes:
            return DocumentData(confidence=0.0, raw={"error": "no_doc_bytes"})
        try:
            return await asyncio.wait_for(
                provider.extract_document(doc_bytes), timeout=_T_OCR
            )
        except (asyncio.TimeoutError, KYCProviderError, Exception) as e:
            logger.warning("OCR falló: %s", e)
            return _fallback_doc

    async def _safe_face() -> float:
        if not selfie_bytes or not doc_bytes:
            return 0.0
        try:
            return await asyncio.wait_for(
                provider.verify_face(selfie_bytes, doc_bytes), timeout=_T_BIOMETRY
            )
        except (asyncio.TimeoutError, KYCProviderError, Exception) as e:
            logger.warning("Face match falló: %s", e)
            return 0.0

    async def _safe_liveness() -> LivenessResult:
        if not selfie_bytes:
            return LivenessResult(passed=False, score=0.0, reason="NO_SELFIE")
        try:
            return await asyncio.wait_for(
                provider.check_liveness(selfie_bytes), timeout=_T_LIVENESS
            )
        except (asyncio.TimeoutError, KYCProviderError, Exception) as e:
            logger.warning("Liveness falló: %s", e)
            return _fallback_liveness

    ocr_data, face_score, liveness = await asyncio.gather(
        _safe_ocr(), _safe_face(), _safe_liveness()
    )
    return ocr_data, face_score, liveness


async def _run_screening_with_timeout(
    db: AsyncSession,
    app: KycApplication,
    full_name: str,
    birth_date: str | None,
    nationality: str,
) -> dict[str, ScreeningMatch]:
    """Ejecuta screening con timeout; en fallo devuelve match_found=False."""
    try:
        return await asyncio.wait_for(
            run_full_screening(db, app, full_name, birth_date, nationality),
            timeout=_T_SCREENING,
        )
    except asyncio.TimeoutError:
        logger.error("Screening timeout para app=%s", app.id)
        fallback = ScreeningMatch(found=False, details={"error": "timeout"})
        return {"SANCTIONS": fallback, "PEP": fallback, "ADVERSE_MEDIA": fallback}


async def _get_aml_context(db: AsyncSession, user_id: UUID) -> dict:
    """Consulta el historial de transacciones para extraer contexto AML."""
    from sqlalchemy import func
    from datetime import timedelta

    now = datetime.now(tz=timezone.utc)
    since_30d = now - timedelta(days=30)

    flagged_count = await db.scalar(
        select(func.count(Transaction.id)).where(
            and_(Transaction.user_id == user_id, Transaction.flagged == True)
        )
    ) or 0

    volume_row = await db.execute(
        select(func.sum(Transaction.amount), func.count(Transaction.id)).where(
            and_(
                Transaction.user_id  == user_id,
                Transaction.created_at >= since_30d,
            )
        )
    )
    vol_sum, vol_count = volume_row.one()

    return {
        "flagged_count": flagged_count,
        "volume_30d":    float(vol_sum or 0),
        "count_30d":     int(vol_count or 0),
    }


async def _get_personal_data(db: AsyncSession, app_id: UUID) -> KycPersonalData | None:
    result = await db.execute(
        select(KycPersonalData).where(KycPersonalData.application_id == app_id)
    )
    return result.scalar_one_or_none()


async def _persist_doc_metrics(
    db: AsyncSession,
    app: KycApplication,
    user_id: UUID,
    ocr_data: DocumentData,
    face_score: float,
    liveness: LivenessResult,
) -> None:
    """Actualiza el último KycDocument con las métricas del proveedor."""
    result = await db.execute(
        select(KycDocument)
        .where(
            and_(
                KycDocument.user_id == user_id,
                KycDocument.doc_type.in_(["doc_front", "document"]),
            )
        )
        .order_by(KycDocument.created_at.desc())
        .limit(1)
    )
    doc = result.scalar_one_or_none()
    if doc:
        doc.ocr_confidence   = ocr_data.confidence
        doc.face_match_score = face_score
        doc.liveness_passed  = liveness.passed
        doc.liveness_score   = liveness.score
        doc.ocr_raw_data     = ocr_data.raw
        doc.verified_at      = datetime.now(tz=timezone.utc)
        # Copiar número de documento si OCR lo extrajo
        if ocr_data.doc_number and not doc.document_number:
            doc.document_number = ocr_data.doc_number
        # Expiración
        if ocr_data.expiry_date and not doc.expiry_date:
            from datetime import date
            try:
                doc.expiry_date = date.fromisoformat(ocr_data.expiry_date)
            except ValueError:
                pass


def _apply_user_status(user: User, decision: str, now: datetime) -> str:
    """Actualiza user.wallet_kyc_status según la decisión y devuelve el estado para el cliente."""
    if decision == "AUTO_APPROVED":
        user.wallet_kyc_status      = "approved"
        user.wallet_kyc_reviewed_at = now
        user.status                 = "ACTIVE"
        return "approved"
    elif decision in ("REJECTED",):
        user.wallet_kyc_status = "rejected"
        return "rejected"
    elif decision == "BLOCKED":
        user.wallet_kyc_status = "suspended"
        user.status            = "BLOCKED"
        return "suspended"
    else:  # MANUAL_REVIEW
        user.wallet_kyc_status       = "pending"
        user.wallet_kyc_submitted_at = now
        return "pending"


async def _notify_bange(decision: str, application_id: str, risk_score: int) -> None:
    """
    Notifica a BANGE vía webhook.
    AUTO_APPROVED → solo informativo.
    MANUAL_REVIEW → enviar a cola de revisión.
    """
    from app.config import get_settings
    import httpx as _httpx

    s = get_settings()
    bange_url = getattr(s, "bange_api_url", "")
    if not bange_url:
        return

    payload = {
        "event":          "kyc.decision",
        "application_id": application_id,
        "decision":       decision,
        "risk_score":     risk_score,
        "requires_review": decision == "MANUAL_REVIEW",
    }
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{bange_url.rstrip('/')}/kyc/notifications",
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    except Exception as e:
        logger.warning("Notificación BANGE fallida: %s", e)


# Import httpx aquí para el helper _download_from_url
try:
    import httpx
except ImportError:
    httpx = None  # type: ignore
