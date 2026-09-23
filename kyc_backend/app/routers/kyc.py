"""
Router /kyc — endpoints para el usuario de la app.
Todos los endpoints requieren token JWT de usuario (del Render API).
"""
import os
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, get_client_ip
from app.core.audit import log_action
from app.core.encryption import encrypt_if_present
from app.core.exceptions import KYCAlreadySubmitted, KYCCannotResubmit
from app.database import get_db
from app.models.kyc_application import KycApplication
from app.models.kyc_document import KycDocument
from app.models.kyc_personal_data import KycPersonalData
from app.models.user import User
from app.schemas.kyc import (
    KycDraftRequest, KycStatusResponse, KycRecordResponse,
    KycSubmitRequest, KycSubmitResponse, UploadResponse,
)
from app.services.storage import upload_kyc_document

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

# ── GET /kyc/status ───────────────────────────────────────────────
@router.get("/status", response_model=KycStatusResponse)
async def kyc_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication).where(KycApplication.user_id == user.id)
    )
    app = result.scalar_one_or_none()

    return KycStatusResponse(
        kyc_status=user.wallet_kyc_status or "none",
        kyc_record=KycRecordResponse.model_validate(app) if app else None,
        rejection_reason=user.wallet_kyc_reject_reason,
        wallet_enabled=(user.wallet_kyc_status == "approved"),
    )


# ── GET /kyc/draft ────────────────────────────────────────────────
@router.get("/draft")
async def get_draft(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication).where(KycApplication.user_id == user.id)
    )
    app = result.scalar_one_or_none()
    return {"draft": app}


# ── POST /kyc/draft ───────────────────────────────────────────────
@router.post("/draft", status_code=200)
async def save_draft(
    body: KycDraftRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication).where(KycApplication.user_id == user.id)
    )
    app = result.scalar_one_or_none()

    if app and app.status not in ("draft", "rejected", "REJECTED"):
        raise HTTPException(409, detail={
            "error": "KYC_NOT_EDITABLE",
            "message": f"No puedes editar en estado: {app.status}"
        })

    data = {
        "full_name":   body.full_name,
        "birth_date":  body.birth_date,
        "nationality": body.nationality,
        "gender":      body.gender,
        "address":     body.address,
        "city":        body.city,
        "occupation":  body.occupation,
        "doc_type":    body.doc_type,
        "doc_number":  body.doc_number,
        "doc_expiry":  body.doc_expiry,
        "status":      "draft",
        "ip_address":  get_client_ip(request),
    }

    if app:
        for k, v in data.items():
            setattr(app, k, v)
    else:
        app = KycApplication(user_id=user.id, session_id=str(uuid4()), **data)
        db.add(app)

    await db.flush()
    await log_action(db, action="KYC_DRAFT_SAVED", user_id=user.id,
                     application_id=app.id, details={"step": "draft"})
    await db.commit()
    return {"success": True, "kyc_id": str(app.id)}


# ── POST /kyc/upload ──────────────────────────────────────────────
@router.post("/upload", response_model=UploadResponse)
@limiter.limit("10/minute")
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    doc_type: str = Form(..., description="doc_front | doc_back | selfie"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if doc_type not in ("doc_front", "doc_back", "selfie"):
        raise HTTPException(400, detail={"error": "INVALID_DOC_TYPE",
                                          "message": "doc_type debe ser: doc_front, doc_back o selfie"})

    content_type = file.content_type or "image/jpeg"
    if content_type not in ("image/jpeg", "image/png", "image/webp", "application/pdf"):
        raise HTTPException(400, detail={"error": "INVALID_FILE_TYPE",
                                          "message": "Solo se aceptan JPEG, PNG, WEBP o PDF"})

    file_bytes = await file.read()
    if len(file_bytes) > 10 * 1024 * 1024:  # 10 MB
        raise HTTPException(413, detail={"error": "FILE_TOO_LARGE", "message": "Máximo 10 MB"})

    ext = content_type.split("/")[-1].replace("jpeg", "jpg")
    file_name = f"{doc_type}_{int(datetime.now().timestamp())}.{ext}"

    url = await upload_kyc_document(
        file_bytes=file_bytes,
        file_name=file_name,
        content_type=content_type,
        user_id=str(user.id),
        doc_type=doc_type,
    )

    # Cifrar URL antes de guardar en BD
    encrypted_url = encrypt_if_present(url)

    # Guardar registro de documento
    doc = KycDocument(
        user_id=user.id,
        doc_type=doc_type,
        file_url=encrypted_url,
        mime_type=content_type,
        file_size=len(file_bytes),
    )
    db.add(doc)
    await log_action(db, action="DOCUMENT_UPLOADED", user_id=user.id,
                     details={"doc_type": doc_type, "size_bytes": len(file_bytes)})
    await db.commit()

    return UploadResponse(success=True, url=url, path=file_name, doc_type=doc_type)


# ── POST /kyc/submit ──────────────────────────────────────────────
@router.post("/submit", response_model=KycSubmitResponse)
@limiter.limit("5/minute")
async def submit_kyc(
    body: KycSubmitRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Importaciones locales para evitar ciclos
    from app.services.kyc_service import process_kyc_submission

    result = await db.execute(
        select(KycApplication).where(KycApplication.user_id == user.id)
    )
    app = result.scalar_one_or_none()

    if app and app.status in ("submitted", "PENDING_REVIEW", "under_review",
                               "AUTO_APPROVED", "MANUAL_REVIEW", "approved", "APPROVED"):
        raise KYCAlreadySubmitted()

    ip = get_client_ip(request)
    kyc_id, kyc_status = await process_kyc_submission(db, user, body, ip, app)

    return KycSubmitResponse(
        success=True,
        kyc_id=kyc_id,
        kyc_status=kyc_status,
        message="Solicitud enviada. Revisaremos tu identidad en 24-48 horas hábiles.",
    )


# ── POST /kyc/resubmit ────────────────────────────────────────────
@router.post("/resubmit", status_code=200)
async def resubmit_kyc(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication).where(KycApplication.user_id == user.id)
    )
    app = result.scalar_one_or_none()

    if not app:
        raise HTTPException(404, detail={"error": "KYC_NOT_FOUND", "message": "No tienes solicitud KYC"})

    if app.status not in ("rejected", "REJECTED"):
        raise KYCCannotResubmit(app.status)

    app.status = "draft"
    app.rejection_reason = None
    app.reviewer_notes = None
    app.submitted_at = None
    app.reviewed_at = None
    app.bank_decision = None
    app.bank_notes = None

    user.wallet_kyc_status = "none"

    await log_action(db, action="KYC_RESUBMIT_RESET", user_id=user.id,
                     application_id=app.id, details={})
    await db.commit()
    return {"success": True, "message": "Puedes volver a enviar tu solicitud KYC"}
