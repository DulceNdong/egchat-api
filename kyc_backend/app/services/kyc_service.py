"""
Servicio KYC — orquesta el envío final:
1. Upsert KycApplication con datos del formulario
2. Upsert KycPersonalData (tabla separada)
3. Run screening (SANCTIONS / PEP / ADVERSE_MEDIA)
4. Calcular risk_score con el motor de decisión
5. Aplicar decisión automática o enviar a revisión manual
6. Actualizar users.wallet_kyc_status
7. Insertar en kyc_audit_log
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_action
from app.core.encryption import encrypt_if_present
from app.models.kyc_application import KycApplication
from app.models.kyc_personal_data import KycPersonalData
from app.models.user import User
from app.schemas.kyc import KycSubmitRequest
from app.services.decision_engine import RiskFactors, calculate_risk_score
from app.services.screening import run_full_screening

logger = logging.getLogger("egchat.kyc.service")


async def process_kyc_submission(
    db: AsyncSession,
    user: User,
    body: KycSubmitRequest,
    ip_address: str,
    existing_app: KycApplication | None,
) -> tuple[UUID, str]:
    """
    Procesa el envío completo del KYC.
    Devuelve (kyc_id, kyc_status).
    """
    now = datetime.now(tz=timezone.utc)

    # ── 1. Upsert KycApplication ──────────────────────────────────
    if existing_app:
        app = existing_app
    else:
        app = KycApplication(user_id=user.id, session_id=str(uuid4()))
        db.add(app)

    # Cifrar URLs de documentos antes de guardar
    app.full_name    = body.full_name
    app.birth_date   = datetime.fromisoformat(body.birth_date)
    app.nationality  = body.nationality
    app.gender       = body.gender
    app.address      = body.address
    app.city         = body.city
    app.occupation   = body.occupation
    app.doc_type     = body.doc_type
    app.doc_number   = body.doc_number
    app.doc_expiry   = datetime.fromisoformat(body.doc_expiry) if body.doc_expiry else None
    app.doc_front_url = encrypt_if_present(body.doc_front_url)
    app.doc_back_url  = encrypt_if_present(body.doc_back_url)
    app.selfie_url    = encrypt_if_present(body.selfie_url)
    app.device_info  = body.device_info
    app.ip_address   = ip_address
    app.status       = "submitted"
    app.submitted_at = now

    await db.flush()   # obtener app.id si es nuevo

    # ── 2. Upsert KycPersonalData ─────────────────────────────────
    pd_result = await db.execute(
        select(KycPersonalData).where(KycPersonalData.application_id == app.id)
    )
    pd = pd_result.scalar_one_or_none() or KycPersonalData(application_id=app.id)

    pd.full_name            = body.full_name
    pd.date_of_birth        = datetime.fromisoformat(body.birth_date).date()
    pd.nationality          = body.nationality
    pd.sex                  = body.gender
    pd.profession           = body.profession
    pd.employer             = body.employer
    pd.monthly_income_range = body.monthly_income_range
    pd.source_of_funds      = body.source_of_funds
    pd.politically_exposed  = body.politically_exposed
    # Cifrar datos de contacto si vienen en device_info
    pd.phone = encrypt_if_present(body.device_info.get("phone"))
    pd.email = encrypt_if_present(body.device_info.get("email"))

    db.add(pd)
    await db.flush()

    # ── 3. Screening ──────────────────────────────────────────────
    screening_results = await run_full_screening(
        db=db,
        application=app,
        full_name=body.full_name,
        dob=body.birth_date,
        nationality=body.nationality,
    )

    # ── 4. Motor de decisión ──────────────────────────────────────
    factors = RiskFactors(
        sanctions_match    = screening_results["SANCTIONS"].found,
        pep_match          = screening_results["PEP"].found,
        adverse_media_match= screening_results["ADVERSE_MEDIA"].found,
        politically_exposed= body.politically_exposed,
        source_of_funds    = body.source_of_funds,
        monthly_income_range = body.monthly_income_range,
        nationality        = body.nationality,
        # Métricas de documento — si ya se subieron antes del submit
        # Se leerán del último KycDocument del usuario si existen
    )

    # Intentar recuperar métricas del documento subido
    from app.models.kyc_document import KycDocument
    doc_result = await db.execute(
        select(KycDocument)
        .where(KycDocument.user_id == user.id)
        .order_by(KycDocument.created_at.desc())
        .limit(1)
    )
    last_doc = doc_result.scalar_one_or_none()
    if last_doc:
        factors.ocr_confidence  = float(last_doc.ocr_confidence) if last_doc.ocr_confidence else None
        factors.face_match_score= float(last_doc.face_match_score) if last_doc.face_match_score else None
        factors.liveness_passed = last_doc.liveness_passed

    decision = calculate_risk_score(factors)

    # ── 5. Aplicar decisión ───────────────────────────────────────
    app.risk_score = decision.risk_score
    app.risk_level = decision.risk_level
    app.status     = decision.decision   # AUTO_APPROVED | MANUAL_REVIEW | BLOCKED

    # ── 6. Actualizar users.wallet_kyc_status ─────────────────────
    if decision.decision == "AUTO_APPROVED":
        user.wallet_kyc_status    = "approved"
        user.wallet_kyc_reviewed_at = now
        user.status               = "ACTIVE"
        kyc_status_for_user       = "approved"
    elif decision.decision == "BLOCKED":
        user.wallet_kyc_status    = "suspended"
        user.status               = "BLOCKED"
        kyc_status_for_user       = "suspended"
    else:
        user.wallet_kyc_status    = "pending"
        user.wallet_kyc_submitted_at = now
        kyc_status_for_user       = "pending"

    # ── 7. Audit log ──────────────────────────────────────────────
    await log_action(
        db,
        action=f"KYC_{decision.decision}",
        application_id=app.id,
        user_id=user.id,
        details={
            "risk_score":  decision.risk_score,
            "risk_level":  decision.risk_level,
            "factors":     decision.factors,
            "sanctions":   screening_results["SANCTIONS"].found,
            "pep":         screening_results["PEP"].found,
            "media":       screening_results["ADVERSE_MEDIA"].found,
        },
        ip_address=ip_address,
    )

    await db.commit()

    logger.info(
        "KYC submit — user:%s app:%s decision:%s score:%d",
        user.id, app.id, decision.decision, decision.risk_score,
    )
    return app.id, kyc_status_for_user
