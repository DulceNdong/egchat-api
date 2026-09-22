"""
Router /admin/kyc — revisión KYC para admins y BANGE.

Roles:
  GET  /pending    → READ_ROLES  (todos los admins activos)
  GET  /{id}       → READ_ROLES
  POST /{id}/review → REVIEW_ROLES (SUPER_ADMIN, COMPLIANCE_OFFICER)
  POST /{id}/bank-decision → BANGE_ROLES (SUPER_ADMIN, BANK_VIEWER de entidad BANGE)
  GET  /stats      → READ_ROLES
"""
from __future__ import annotations
import math
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.dependencies import (
    get_current_admin, require_roles,
    READ_ROLES, REVIEW_ROLES, BANGE_ROLES,
)
from app.core.audit import log_action
from app.core.exceptions import KYCNotFound
from app.database import get_db
from app.models.admin_user import AdminUser
from app.models.kyc_application import KycApplication
from app.models.kyc_screening import KycScreeningResult
from app.models.sar import SuspiciousActivityReport
from app.models.user import User
from app.schemas.admin import (
    BankDecisionRequest, BankDecisionResponse,
    KycDetailResponse, KycListItem, KycListResponse,
    KycStatsResponse, ReviewRequest, ReviewResponse,
)
from app.services.notifications import notify_user_kyc_decision

router = APIRouter()


# ── GET /admin/kyc/stats ──────────────────────────────────────────
@router.get("/stats", response_model=KycStatsResponse)
async def kyc_stats(
    admin: AdminUser = Depends(require_roles(*READ_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    from datetime import date
    today_start = datetime.combine(date.today(), datetime.min.time()).replace(tzinfo=timezone.utc)

    total = await db.scalar(select(func.count(KycApplication.id)))
    pending = await db.scalar(
        select(func.count(KycApplication.id))
        .where(KycApplication.status.in_(["submitted", "PENDING_REVIEW", "under_review", "MANUAL_REVIEW"]))
    )
    approved_today = await db.scalar(
        select(func.count(KycApplication.id))
        .where(and_(
            KycApplication.status.in_(["approved", "APPROVED", "AUTO_APPROVED"]),
            KycApplication.reviewed_at >= today_start,
        ))
    )
    rejected_today = await db.scalar(
        select(func.count(KycApplication.id))
        .where(and_(
            KycApplication.status.in_(["rejected", "REJECTED"]),
            KycApplication.reviewed_at >= today_start,
        ))
    )
    avg_score = await db.scalar(select(func.avg(KycApplication.risk_score))) or 0.0
    high_risk = await db.scalar(
        select(func.count(KycApplication.id))
        .where(KycApplication.risk_level.in_(["high", "HIGH"]))
    )
    screening_hits = await db.scalar(
        select(func.count(KycScreeningResult.id))
        .where(and_(KycScreeningResult.match_found == True, KycScreeningResult.reviewed == False))
    )
    sars_overdue = await db.scalar(
        select(func.count(SuspiciousActivityReport.id))
        .where(and_(
            SuspiciousActivityReport.status.notin_(["SENT_TO_ANIF", "ACKNOWLEDGED", "CLOSED"]),
            SuspiciousActivityReport.detected_at < func.now() - func.cast("72 hours", type_=None),
        ))
    ) or 0

    return KycStatsResponse(
        total_applications=total or 0,
        pending_review=pending or 0,
        approved_today=approved_today or 0,
        rejected_today=rejected_today or 0,
        avg_risk_score=round(float(avg_score), 1),
        high_risk_count=high_risk or 0,
        screening_hits_unreviewed=screening_hits or 0,
        sars_overdue=sars_overdue,
    )


# ── GET /admin/kyc/pending ────────────────────────────────────────
@router.get("/pending", response_model=KycListResponse)
async def list_pending(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    status_filter: str | None = Query(default=None, alias="status"),
    risk_level: str | None = Query(default=None),
    admin: AdminUser = Depends(require_roles(*READ_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    # BANK_VIEWER de BANGE solo ve las pendientes de decisión banco
    if admin.role == "BANK_VIEWER" and admin.entity == "BANGE":
        default_statuses = ["MANUAL_REVIEW", "under_review", "AUTO_APPROVED"]
    else:
        default_statuses = ["submitted", "PENDING_REVIEW", "under_review", "MANUAL_REVIEW"]

    statuses = [status_filter] if status_filter else default_statuses

    filters = [KycApplication.status.in_(statuses)]
    if risk_level:
        filters.append(KycApplication.risk_level == risk_level.lower())

    total = await db.scalar(
        select(func.count(KycApplication.id)).where(and_(*filters))
    ) or 0

    result = await db.execute(
        select(KycApplication, User)
        .join(User, User.id == KycApplication.user_id)
        .where(and_(*filters))
        .order_by(KycApplication.submitted_at.asc().nullslast())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = result.all()

    items: list[KycListItem] = []
    for app, user in rows:
        # Contar screening hits
        hits = await db.scalar(
            select(func.count(KycScreeningResult.id))
            .where(and_(
                KycScreeningResult.application_id == app.id,
                KycScreeningResult.match_found == True,
            ))
        ) or 0

        items.append(KycListItem(
            application_id=app.id,
            session_id=app.session_id,
            status=app.status,
            risk_level=app.risk_level,
            risk_score=app.risk_score,
            bank_decision=app.bank_decision,
            submitted_at=app.submitted_at,
            created_at=app.created_at,
            user_phone=user.phone,
            user_status=user.status,
            full_name=app.full_name,
            nationality=app.nationality,
            document_type=app.doc_type,
            ocr_confidence=None,
            face_match_score=None,
            liveness_passed=None,
            screening_hits=hits,
        ))

    return KycListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        pages=math.ceil(total / page_size),
    )


# ── GET /admin/kyc/{id} ───────────────────────────────────────────
@router.get("/{application_id}", response_model=KycDetailResponse)
async def get_kyc_detail(
    application_id: UUID,
    admin: AdminUser = Depends(require_roles(*READ_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication)
        .options(
            selectinload(KycApplication.user),
            selectinload(KycApplication.personal_data),
            selectinload(KycApplication.screening_results),
        )
        .where(KycApplication.id == application_id)
    )
    app = result.scalar_one_or_none()
    if not app:
        raise KYCNotFound()

    pd = app.personal_data
    user = app.user

    # Serializar screening
    from app.schemas.admin import ScreeningResultResponse
    screening = [ScreeningResultResponse.model_validate(s) for s in app.screening_results]

    return KycDetailResponse(
        id=app.id,
        session_id=app.session_id,
        status=app.status,
        risk_level=app.risk_level,
        risk_score=app.risk_score,
        bank_decision=app.bank_decision,
        bank_notes=app.bank_notes,
        bank_decision_at=app.bank_decision_at,
        rejection_reason=app.rejection_reason,
        reviewer_notes=app.reviewer_notes,
        reviewed_at=app.reviewed_at,
        submitted_at=app.submitted_at,
        created_at=app.created_at,
        user_id=user.id,
        user_phone=user.phone,
        full_name=pd.full_name if pd else app.full_name,
        nationality=pd.nationality if pd else app.nationality,
        birth_date=str(pd.date_of_birth) if pd else None,
        profession=pd.profession if pd else None,
        source_of_funds=pd.source_of_funds if pd else None,
        politically_exposed=pd.politically_exposed if pd else None,
        doc_type=app.doc_type,
        doc_number=app.doc_number,
        # URLs cifradas — NO las devolvemos en texto plano aquí
        # El frontend debe pedirlas a un endpoint separado con token de descarga
        doc_front_url="[CIFRADO]" if app.doc_front_url else None,
        doc_back_url="[CIFRADO]"  if app.doc_back_url  else None,
        selfie_url="[CIFRADO]"    if app.selfie_url     else None,
        ocr_confidence=None,
        face_match_score=None,
        liveness_passed=None,
        screening_results=screening,
    )


# ── POST /admin/kyc/{id}/review ───────────────────────────────────
@router.post("/{application_id}/review", response_model=ReviewResponse)
async def review_application(
    application_id: UUID,
    body: ReviewRequest,
    admin: AdminUser = Depends(require_roles(*REVIEW_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication).options(selectinload(KycApplication.user))
        .where(KycApplication.id == application_id)
    )
    app = result.scalar_one_or_none()
    if not app:
        raise KYCNotFound()

    if app.status in ("approved", "APPROVED", "BLOCKED"):
        raise HTTPException(409, detail={
            "error": "KYC_ALREADY_FINAL",
            "message": f"Esta solicitud ya está en estado final: {app.status}",
        })

    decision = body.decision.upper()
    if decision in ("REJECTED",) and not body.rejection_reason:
        raise HTTPException(400, detail={
            "error": "REASON_REQUIRED",
            "message": "rejection_reason es obligatorio al rechazar",
        })

    now = datetime.now(tz=timezone.utc)
    app.status            = decision
    app.reviewed_by_admin = admin.id
    app.reviewed_at       = now
    app.reviewer_notes    = body.notes
    app.rejection_reason  = body.rejection_reason if decision == "REJECTED" else None

    user = app.user
    if decision in ("APPROVED",):
        user.wallet_kyc_status     = "approved"
        user.wallet_kyc_reviewed_at = now
        user.status                = "ACTIVE"
    elif decision == "REJECTED":
        user.wallet_kyc_status     = "rejected"
        user.wallet_kyc_reject_reason = body.rejection_reason
    elif decision == "BLOCKED":
        user.wallet_kyc_status     = "suspended"
        user.status                = "BLOCKED"

    await log_action(
        db, action=f"KYC_{decision}",
        application_id=app.id, user_id=user.id, admin_id=admin.id,
        details={"decision": decision, "reason": body.rejection_reason, "notes": body.notes},
    )

    await db.commit()

    # Notificar al usuario
    await notify_user_kyc_decision(user_id=str(user.id), decision=decision,
                                    rejection_reason=body.rejection_reason)

    return ReviewResponse(
        success=True,
        application_id=app.id,
        new_status=decision,
        message=f"Solicitud {decision.lower()} correctamente",
    )


# ── POST /admin/kyc/{id}/bank-decision ───────────────────────────
@router.post("/{application_id}/bank-decision", response_model=BankDecisionResponse)
async def bank_decision(
    application_id: UUID,
    body: BankDecisionRequest,
    admin: AdminUser = Depends(require_roles(*BANGE_ROLES)),
    db: AsyncSession = Depends(get_db),
):
    # Solo BANGE puede poner decisión de banco
    if admin.entity != "BANGE" and admin.role != "SUPER_ADMIN":
        raise HTTPException(403, detail={
            "error": "BANGE_ONLY",
            "message": "Solo revisores de entidad BANGE pueden registrar esta decisión",
        })

    result = await db.execute(
        select(KycApplication).options(selectinload(KycApplication.user))
        .where(KycApplication.id == application_id)
    )
    app = result.scalar_one_or_none()
    if not app:
        raise KYCNotFound()

    now = datetime.now(tz=timezone.utc)
    app.bank_decision    = body.decision
    app.bank_decision_at = now
    app.bank_notes       = body.notes
    app.bank_reviewer_id = admin.id

    # Si BANGE aprueba → estado final APPROVED
    if body.decision == "APPROVED":
        app.status = "APPROVED"
        app.user.wallet_kyc_status = "approved"
        app.user.wallet_kyc_reviewed_at = now
        app.user.status = "ACTIVE"
    elif body.decision == "REJECTED":
        app.status = "REJECTED"
        app.user.wallet_kyc_status = "rejected"
        app.user.wallet_kyc_reject_reason = body.notes

    await log_action(
        db, action=f"BANK_DECISION_{body.decision}",
        application_id=app.id, admin_id=admin.id,
        details={"bank_decision": body.decision, "notes": body.notes},
    )
    await db.commit()

    await notify_user_kyc_decision(
        user_id=str(app.user_id),
        decision=f"BANK_{body.decision}",
        rejection_reason=body.notes,
    )

    return BankDecisionResponse(
        success=True,
        application_id=app.id,
        bank_decision=body.decision,
        message=f"Decisión BANGE registrada: {body.decision}",
    )
