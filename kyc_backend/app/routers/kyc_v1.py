"""
Router /api/v1/kyc — Orquestador KYC completo (multi-paso + submit con pipeline).

Endpoints (en orden del flujo):
  POST /api/v1/kyc/init                      → inicia sesión KYC
  GET  /api/v1/kyc/{session_id}/status       → estado de la sesión
  POST /api/v1/kyc/{session_id}/personal     → paso 1: datos personales
  POST /api/v1/kyc/{session_id}/document     → paso 2: documento identidad (multipart)
  POST /api/v1/kyc/{session_id}/selfie       → paso 3: selfie (multipart)
  POST /api/v1/kyc/{session_id}/financial    → paso 4: datos financieros
  POST /api/v1/kyc/{session_id}/consent      → paso 5: firma de consentimiento
  POST /api/v1/kyc/{session_id}/submit       → envío final + pipeline completo
  POST /api/v1/kyc/resubmit                  → reintentar tras rechazo

Idempotencia: header Idempotency-Key en todos los POST de pasos.
Rate-limit:   5 intentos /init por user_id cada 24h (tabla kyc_attempts).
"""
from __future__ import annotations
import logging
from datetime import date, datetime, timezone
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import (
    APIRouter, Depends, File, Form, Header, HTTPException,
    Request, UploadFile, status,
)
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, get_client_ip
from app.config import get_settings
from app.core.audit import log_action
from app.core.encryption import encrypt_if_present
from app.database import get_db
from app.models.kyc_application import KycApplication
from app.models.kyc_document import KycDocument
from app.models.kyc_personal_data import KycPersonalData
from app.models.user import User
from app.services.kyc_rate_limit import (
    check_and_record_attempt, mark_attempt_success, get_attempts_today,
)
from app.services.storage import upload_kyc_document

router = APIRouter()
logger = logging.getLogger("egchat.kyc.v1")
settings = get_settings()

# ── Constantes de estado ──────────────────────────────────────────
S_IN_PROGRESS   = "IN_PROGRESS"
S_PENDING_SUBMIT= "PENDING_SUBMIT"
S_SUBMITTED     = "submitted"


# ══════════════════════════════════════════════════════════════════
# SCHEMAS INTERNOS
# ══════════════════════════════════════════════════════════════════

class InitResponse(BaseModel):
    session_id: UUID
    status: str
    attempts_today: int
    attempts_remaining: int
    message: str


class StepResponse(BaseModel):
    session_id: UUID
    step: str
    status: str
    message: str


class PersonalDataStep(BaseModel):
    full_name:    str  = Field(..., min_length=3, max_length=200)
    birth_date:   str  = Field(..., description="YYYY-MM-DD")
    place_of_birth: str | None = None
    nationality:  str  = Field(default="GQ", max_length=10)
    sex:          str | None = Field(default=None, pattern="^[MFO]$")
    marital_status: str | None = None
    address:      str | None = None
    city:         str | None = None
    province:     str | None = None
    country:      str = "GQ"

    @field_validator("birth_date", mode="before")
    @classmethod
    def validate_dob(cls, v: str) -> str:
        try:
            dob = date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"Fecha inválida: {v}. Usar YYYY-MM-DD")
        age = (date.today() - dob).days / 365.25
        if age < 18:
            raise ValueError("Debes ser mayor de 18 años para activar el monedero")
        return v


class FinancialDataStep(BaseModel):
    phone:               str | None = None
    email:               str | None = None
    profession:          str | None = None
    employer:            str | None = None
    monthly_income_range: str | None = Field(
        default=None,
        description="UNDER_100K | 100K_500K | 500K_1M | 1M_5M | OVER_5M"
    )
    source_of_funds:     str | None = Field(
        default=None,
        description="SALARY | BUSINESS | SAVINGS | INVESTMENT | PENSION | REMITTANCE | OTHER"
    )
    politically_exposed: bool = False
    pep_details:         str | None = None
    # Factores de canal (para matriz COBAC)
    channel:             str = Field(
        default="digital_ekyc",
        description="presencial | digital_ekyc | digital_incomplete"
    )


class ConsentStep(BaseModel):
    accepted_terms:         bool = Field(..., description="Debe ser True")
    accepted_data_processing: bool = Field(..., description="Debe ser True")
    signature_hash:         str | None = Field(
        default=None,
        description="Hash SHA-256 de la firma digital del usuario"
    )
    accepted_at:            str | None = None  # ISO datetime del dispositivo


class SubmitResponse(BaseModel):
    session_id: UUID
    decision:   str
    kyc_status: str
    risk_score: int
    risk_level: str
    message:    str


# ── Helper: obtener aplicación por session_id ─────────────────────
async def _get_app_by_session(
    session_id: UUID,
    user_id: UUID,
    db: AsyncSession,
) -> KycApplication:
    result = await db.execute(
        select(KycApplication).where(
            KycApplication.session_id == str(session_id),
            KycApplication.user_id   == user_id,
        )
    )
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(
            status_code=404,
            detail={"error": "SESSION_NOT_FOUND",
                    "message": "Sesión KYC no encontrada. Inicia con POST /kyc/init"},
        )
    return app


# ── Helper: verificar Idempotency-Key ────────────────────────────
_processed_keys: set[str] = set()   # en producción: Redis con TTL 24h

def _check_idempotency(key: str | None, step: str) -> bool:
    """Devuelve True si la clave ya fue procesada (respuesta idempotente)."""
    if not key:
        return False
    cache_key = f"{step}:{key}"
    if cache_key in _processed_keys:
        return True
    _processed_keys.add(cache_key)
    if len(_processed_keys) > 10_000:   # limpiar si crece demasiado
        _processed_keys.clear()
    return False


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/init
# ══════════════════════════════════════════════════════════════════
@router.post("/init", response_model=InitResponse, status_code=201)
async def kyc_init(
    request: Request,
    user:    User         = Depends(get_current_user),
    db:      AsyncSession = Depends(get_db),
):
    """
    Inicia una sesión KYC.
    - Rate-limit: 5 intentos por user_id cada 24h
    - Si ya existe una sesión IN_PROGRESS, la devuelve (idempotente)
    - Si la sesión previa fue REJECTED, crea una nueva
    """
    max_attempts = getattr(settings, "kyc_max_attempts_per_day", 5)
    ip  = get_client_ip(request)
    ua  = request.headers.get("User-Agent", "")

    # Comprobar si ya hay sesión activa recuperable
    existing = await db.execute(
        select(KycApplication).where(
            KycApplication.user_id == user.id,
            KycApplication.status.in_([
                S_IN_PROGRESS, "draft", S_PENDING_SUBMIT
            ]),
        )
    )
    active_app = existing.scalar_one_or_none()
    if active_app:
        attempts_today = await get_attempts_today(db, user.id)
        return InitResponse(
            session_id=UUID(active_app.session_id) if active_app.session_id else uuid4(),
            status=active_app.status,
            attempts_today=attempts_today,
            attempts_remaining=max(0, max_attempts - attempts_today),
            message="Sesión KYC activa recuperada. Continúa desde donde lo dejaste.",
        )

    # Verificar rate-limit y registrar intento
    allowed, reason = await check_and_record_attempt(db, user.id, ip, ua)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={"error": "KYC_RATE_LIMIT", "message": reason},
            headers={"Retry-After": "86400"},
        )

    # Crear nueva aplicación
    session_id = uuid4()
    app = KycApplication(
        user_id    = user.id,
        session_id = str(session_id),
        status     = S_IN_PROGRESS,
        ip_address = ip,
        device_info= {"user_agent": ua},
    )
    db.add(app)
    await db.flush()

    # Marcar intento como exitoso
    await mark_attempt_success(db, user.id, session_id)

    await log_action(
        db, action="KYC_INIT",
        application_id=app.id,
        user_id=user.id,
        ip_address=ip,
        details={"session_id": str(session_id)},
    )
    await db.commit()

    attempts_today = await get_attempts_today(db, user.id)
    logger.info("KYC init: user=%s session=%s", user.id, session_id)

    return InitResponse(
        session_id=session_id,
        status=S_IN_PROGRESS,
        attempts_today=attempts_today,
        attempts_remaining=max(0, max_attempts - attempts_today),
        message="Sesión KYC iniciada. Completa los pasos para activar tu monedero.",
    )


# ══════════════════════════════════════════════════════════════════
# GET /api/v1/kyc/{session_id}/status
# ══════════════════════════════════════════════════════════════════
@router.get("/{session_id}/status")
async def kyc_session_status(
    session_id: UUID,
    user:       User         = Depends(get_current_user),
    db:         AsyncSession = Depends(get_db),
):
    app = await _get_app_by_session(session_id, user.id, db)

    # Calcular pasos completados
    pd = await db.execute(
        select(KycPersonalData).where(KycPersonalData.application_id == app.id)
    )
    personal = pd.scalar_one_or_none()
    doc = await db.execute(
        select(KycDocument).where(
            KycDocument.user_id  == user.id,
            KycDocument.doc_type.in_(["doc_front", "document"]),
        ).limit(1)
    )
    selfie = await db.execute(
        select(KycDocument).where(
            KycDocument.user_id == user.id,
            KycDocument.doc_type == "selfie",
        ).limit(1)
    )

    steps_completed = {
        "personal":  personal is not None,
        "document":  doc.scalar_one_or_none() is not None,
        "selfie":    selfie.scalar_one_or_none() is not None,
        "financial": personal is not None and personal.source_of_funds is not None,
        "consent":   app.status == S_PENDING_SUBMIT,
    }

    return {
        "session_id":       str(session_id),
        "status":           app.status,
        "steps_completed":  steps_completed,
        "rejection_reason": app.rejection_reason,
        "risk_level":       app.risk_level,
        "created_at":       app.created_at.isoformat() if app.created_at else None,
        "submitted_at":     app.submitted_at.isoformat() if app.submitted_at else None,
    }


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/{session_id}/personal  — Paso 1
# ══════════════════════════════════════════════════════════════════
@router.post("/{session_id}/personal", response_model=StepResponse)
async def step_personal(
    session_id:      UUID,
    body:            PersonalDataStep,
    request:         Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user:            User         = Depends(get_current_user),
    db:              AsyncSession = Depends(get_db),
):
    if _check_idempotency(idempotency_key, f"personal:{session_id}"):
        return StepResponse(session_id=session_id, step="personal",
                            status="IDEMPOTENT", message="Paso ya guardado.")

    app = await _get_app_by_session(session_id, user.id, db)
    _assert_editable(app)

    # Upsert KycPersonalData (parte 1 — identidad)
    pd_res = await db.execute(
        select(KycPersonalData).where(KycPersonalData.application_id == app.id)
    )
    pd = pd_res.scalar_one_or_none() or KycPersonalData(application_id=app.id)

    pd.full_name       = body.full_name
    pd.date_of_birth   = date.fromisoformat(body.birth_date)
    pd.place_of_birth  = body.place_of_birth
    pd.nationality     = body.nationality
    pd.sex             = body.sex
    pd.marital_status  = body.marital_status
    pd.address         = body.address
    pd.city            = body.city
    pd.province        = body.province
    pd.country         = body.country

    # Mantener nombre en la aplicación principal para visibilidad
    app.full_name   = body.full_name
    app.birth_date  = datetime.fromisoformat(body.birth_date)
    app.nationality = body.nationality
    app.gender      = body.sex

    db.add(pd)
    await log_action(db, action="KYC_STEP_PERSONAL", user_id=user.id,
                     application_id=app.id,
                     details={"full_name": body.full_name, "nationality": body.nationality})
    await db.commit()

    return StepResponse(session_id=session_id, step="personal",
                        status=app.status, message="Datos personales guardados.")


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/{session_id}/document  — Paso 2 (multipart)
# ══════════════════════════════════════════════════════════════════
@router.post("/{session_id}/document", response_model=StepResponse)
async def step_document(
    session_id:      UUID,
    request:         Request,
    front:           UploadFile = File(..., description="Foto frontal del documento"),
    back:            UploadFile | None = File(default=None, description="Foto dorsal (opcional)"),
    doc_type:        str = Form(default="dni", description="dni | passport | resident_card"),
    doc_number:      str = Form(..., description="Número del documento"),
    doc_expiry:      str | None = Form(default=None, description="YYYY-MM-DD"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user:            User         = Depends(get_current_user),
    db:              AsyncSession = Depends(get_db),
):
    if _check_idempotency(idempotency_key, f"document:{session_id}"):
        return StepResponse(session_id=session_id, step="document",
                            status="IDEMPOTENT", message="Paso ya guardado.")

    app = await _get_app_by_session(session_id, user.id, db)
    _assert_editable(app)
    _assert_file_size(await front.read(), "front", 10)
    front_bytes = await _reread(front)

    # Upload foto frontal
    front_url = await upload_kyc_document(
        file_bytes=front_bytes,
        file_name=f"doc_front_{session_id}.jpg",
        content_type=front.content_type or "image/jpeg",
        user_id=str(user.id),
        doc_type="doc_front",
    )
    back_url: str | None = None
    if back:
        back_bytes = await back.read()
        _assert_file_size(back_bytes, "back", 10)
        back_url = await upload_kyc_document(
            file_bytes=back_bytes,
            file_name=f"doc_back_{session_id}.jpg",
            content_type=back.content_type or "image/jpeg",
            user_id=str(user.id),
            doc_type="doc_back",
        )

    # Guardar documento
    doc = KycDocument(
        application_id = app.id,
        user_id        = user.id,
        doc_type       = "doc_front",
        document_type  = doc_type.upper(),
        document_number= doc_number.strip(),
        expiry_date    = date.fromisoformat(doc_expiry) if doc_expiry else None,
        front_image_url= encrypt_if_present(front_url),
        back_image_url = encrypt_if_present(back_url),
        mime_type      = front.content_type or "image/jpeg",
        file_size      = len(front_bytes),
    )
    db.add(doc)

    # Actualizar campos del documento en la aplicación principal
    app.doc_type    = doc_type
    app.doc_number  = doc_number.strip()
    app.doc_expiry  = datetime.fromisoformat(doc_expiry) if doc_expiry else None
    app.doc_front_url = encrypt_if_present(front_url)
    app.doc_back_url  = encrypt_if_present(back_url)

    await log_action(db, action="KYC_STEP_DOCUMENT", user_id=user.id,
                     application_id=app.id,
                     details={"doc_type": doc_type, "doc_number": doc_number})
    await db.commit()

    return StepResponse(session_id=session_id, step="document",
                        status=app.status,
                        message="Documento de identidad guardado correctamente.")


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/{session_id}/selfie  — Paso 3 (multipart)
# ══════════════════════════════════════════════════════════════════
@router.post("/{session_id}/selfie", response_model=StepResponse)
async def step_selfie(
    session_id:      UUID,
    request:         Request,
    selfie:          UploadFile = File(..., description="Selfie de verificación (cara visible)"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user:            User         = Depends(get_current_user),
    db:              AsyncSession = Depends(get_db),
):
    if _check_idempotency(idempotency_key, f"selfie:{session_id}"):
        return StepResponse(session_id=session_id, step="selfie",
                            status="IDEMPOTENT", message="Paso ya guardado.")

    app = await _get_app_by_session(session_id, user.id, db)
    _assert_editable(app)

    selfie_bytes = await selfie.read()
    _assert_file_size(selfie_bytes, "selfie", 10)

    selfie_url = await upload_kyc_document(
        file_bytes=selfie_bytes,
        file_name=f"selfie_{session_id}.jpg",
        content_type=selfie.content_type or "image/jpeg",
        user_id=str(user.id),
        doc_type="selfie",
    )

    # Guardar registro de selfie
    doc = KycDocument(
        application_id = app.id,
        user_id        = user.id,
        doc_type       = "selfie",
        selfie_url     = encrypt_if_present(selfie_url),
        mime_type      = selfie.content_type or "image/jpeg",
        file_size      = len(selfie_bytes),
    )
    db.add(doc)
    app.selfie_url = encrypt_if_present(selfie_url)

    await log_action(db, action="KYC_STEP_SELFIE", user_id=user.id,
                     application_id=app.id, details={"size": len(selfie_bytes)})
    await db.commit()

    return StepResponse(session_id=session_id, step="selfie",
                        status=app.status, message="Selfie guardada correctamente.")


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/{session_id}/financial  — Paso 4
# ══════════════════════════════════════════════════════════════════
@router.post("/{session_id}/financial", response_model=StepResponse)
async def step_financial(
    session_id:      UUID,
    body:            FinancialDataStep,
    request:         Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user:            User         = Depends(get_current_user),
    db:              AsyncSession = Depends(get_db),
):
    if _check_idempotency(idempotency_key, f"financial:{session_id}"):
        return StepResponse(session_id=session_id, step="financial",
                            status="IDEMPOTENT", message="Paso ya guardado.")

    app = await _get_app_by_session(session_id, user.id, db)
    _assert_editable(app)

    pd_res = await db.execute(
        select(KycPersonalData).where(KycPersonalData.application_id == app.id)
    )
    pd = pd_res.scalar_one_or_none()
    if not pd:
        raise HTTPException(400, detail={
            "error": "STEP_ORDER",
            "message": "Completa el paso 'personal' antes de 'financial'",
        })

    # Cifrar datos de contacto
    pd.phone                = encrypt_if_present(body.phone)
    pd.email                = encrypt_if_present(body.email)
    pd.profession           = body.profession
    pd.employer             = body.employer
    pd.monthly_income_range = body.monthly_income_range
    pd.source_of_funds      = body.source_of_funds
    pd.politically_exposed  = body.politically_exposed
    pd.pep_details          = body.pep_details

    # Guardar canal en device_info para uso posterior en motor de riesgo
    info = dict(app.device_info or {})
    info["channel"] = body.channel
    app.device_info = info

    await log_action(db, action="KYC_STEP_FINANCIAL", user_id=user.id,
                     application_id=app.id,
                     details={"source_of_funds": body.source_of_funds,
                              "pep": body.politically_exposed,
                              "channel": body.channel})
    await db.commit()

    return StepResponse(session_id=session_id, step="financial",
                        status=app.status, message="Datos financieros guardados.")


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/{session_id}/consent  — Paso 5
# ══════════════════════════════════════════════════════════════════
@router.post("/{session_id}/consent", response_model=StepResponse)
async def step_consent(
    session_id:      UUID,
    body:            ConsentStep,
    request:         Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user:            User         = Depends(get_current_user),
    db:              AsyncSession = Depends(get_db),
):
    if _check_idempotency(idempotency_key, f"consent:{session_id}"):
        return StepResponse(session_id=session_id, step="consent",
                            status="IDEMPOTENT", message="Consentimiento ya registrado.")

    if not body.accepted_terms or not body.accepted_data_processing:
        raise HTTPException(400, detail={
            "error": "CONSENT_REQUIRED",
            "message": "Debes aceptar los términos y el tratamiento de datos para continuar",
        })

    app = await _get_app_by_session(session_id, user.id, db)
    _assert_editable(app)

    # Cambiar estado a PENDING_SUBMIT — listo para el submit final
    app.status = S_PENDING_SUBMIT

    now = datetime.now(tz=timezone.utc).isoformat()
    await log_action(
        db, action="KYC_CONSENT_SIGNED", user_id=user.id,
        application_id=app.id,
        details={
            "accepted_terms": body.accepted_terms,
            "accepted_data_processing": body.accepted_data_processing,
            "signature_hash": body.signature_hash,
            "device_timestamp": body.accepted_at,
            "server_timestamp": now,
            "legal_basis": "COBAC R-2023/01 Art.12 · Ley N°2/2008 GQ",
        },
        ip_address=get_client_ip(request),
    )
    await db.commit()

    return StepResponse(
        session_id=session_id, step="consent",
        status=S_PENDING_SUBMIT,
        message="Consentimiento registrado. Usa POST /submit para completar la verificación.",
    )


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/{session_id}/submit  — Submit final con pipeline
# ══════════════════════════════════════════════════════════════════
@router.post("/{session_id}/submit", response_model=SubmitResponse)
async def session_submit(
    session_id: UUID,
    request:    Request,
    user:       User         = Depends(get_current_user),
    db:         AsyncSession = Depends(get_db),
):
    """
    Ejecuta el pipeline completo:
    OCR → Biometría → Liveness → Screening → Motor de decisión v2
    """
    from app.services.kyc_orchestrator import run_verification_pipeline

    app = await _get_app_by_session(session_id, user.id, db)

    if app.status not in (S_PENDING_SUBMIT, S_IN_PROGRESS, "draft"):
        if app.status in ("submitted", "AUTO_APPROVED", "MANUAL_REVIEW",
                          "approved", "APPROVED"):
            raise HTTPException(409, detail={
                "error": "KYC_ALREADY_SUBMITTED",
                "message": f"Esta sesión ya fue enviada (estado: {app.status})",
            })

    decision, kyc_status, risk_score, risk_level = await run_verification_pipeline(
        db=db,
        app=app,
        user=user,
        ip_address=get_client_ip(request),
    )

    return SubmitResponse(
        session_id=session_id,
        decision=decision,
        kyc_status=kyc_status,
        risk_score=risk_score,
        risk_level=risk_level,
        message=_submit_message(decision),
    )


# ══════════════════════════════════════════════════════════════════
# POST /api/v1/kyc/resubmit
# ══════════════════════════════════════════════════════════════════
@router.post("/resubmit", status_code=200)
async def resubmit(
    user: User         = Depends(get_current_user),
    db:   AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(KycApplication).where(KycApplication.user_id == user.id)
        .order_by(KycApplication.created_at.desc()).limit(1)
    )
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(404, detail={"error": "KYC_NOT_FOUND",
                                          "message": "No tienes ninguna solicitud KYC"})
    if app.status not in ("rejected", "REJECTED"):
        raise HTTPException(409, detail={
            "error": "CANNOT_RESUBMIT",
            "message": f"No puedes reintentar en estado: {app.status}",
        })
    # Resetear para nueva sesión
    app.status            = S_IN_PROGRESS
    app.session_id        = str(uuid4())
    app.rejection_reason  = None
    app.reviewer_notes    = None
    app.submitted_at      = None
    app.reviewed_at       = None
    app.bank_decision     = None
    app.bank_notes        = None
    app.risk_score        = 0
    user.wallet_kyc_status = "none"

    await log_action(db, action="KYC_RESUBMIT", user_id=user.id,
                     application_id=app.id, details={})
    await db.commit()

    return {"success": True, "session_id": app.session_id,
            "message": "Nueva sesión KYC iniciada. Puedes completar los pasos."}


# ── Helpers privados ──────────────────────────────────────────────
def _assert_editable(app: KycApplication) -> None:
    """Lanza 409 si el estado no permite editar."""
    non_editable = {"submitted", "AUTO_APPROVED", "MANUAL_REVIEW",
                    "approved", "APPROVED", "BLOCKED"}
    if app.status in non_editable:
        raise HTTPException(409, detail={
            "error": "KYC_NOT_EDITABLE",
            "message": f"No puedes editar en estado: {app.status}",
        })


def _assert_file_size(data: bytes, name: str, max_mb: int) -> None:
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(413, detail={
            "error": "FILE_TOO_LARGE",
            "message": f"El archivo '{name}' supera el límite de {max_mb} MB",
        })


async def _reread(upload: UploadFile) -> bytes:
    """Re-lee el archivo si ya fue leído (seek no disponible en todos los backends)."""
    await upload.seek(0)
    return await upload.read()


def _submit_message(decision: str) -> str:
    return {
        "AUTO_APPROVED":  "✅ ¡Monedero activado! Tu identidad ha sido verificada automáticamente.",
        "MANUAL_REVIEW":  "⏳ Solicitud enviada. Nuestro equipo revisará tu identidad en 24-48h.",
        "REJECTED":       "❌ Solicitud rechazada. Consulta el motivo en tu perfil.",
        "BLOCKED":        "🚫 Cuenta bloqueada. Contacta con soporte.",
    }.get(decision, "Solicitud procesada.")
