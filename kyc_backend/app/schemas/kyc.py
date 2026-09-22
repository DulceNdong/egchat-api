"""Schemas Pydantic — KYC (usuario de la app)."""
from __future__ import annotations
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID
from typing import Literal
from pydantic import BaseModel, Field, field_validator


# ── Enums como Literal ────────────────────────────────────────────
DocType       = Literal["dni", "passport", "resident_card", "DNI", "PASSPORT", "RESIDENCE_PERMIT"]
KycStatusType = Literal["none","pending","approved","rejected","suspended",
                         "draft","IN_PROGRESS","submitted","PENDING_REVIEW",
                         "under_review","AUTO_APPROVED","MANUAL_REVIEW",
                         "APPROVED","REJECTED","BLOCKED"]
RiskLevel     = Literal["low","medium","high","LOW","MEDIUM","HIGH"]
Gender        = Literal["M","F","O"]
MaritalStatus = Literal["SINGLE","MARRIED","DIVORCED","WIDOWED","OTHER"]
IncomeRange   = Literal["UNDER_100K","100K_500K","500K_1M","1M_5M","OVER_5M"]
SourceOfFunds = Literal["SALARY","BUSINESS","SAVINGS","INVESTMENT","PENSION","REMITTANCE","OTHER"]


# ── Paso 1: Datos personales ──────────────────────────────────────
class KycDraftRequest(BaseModel):
    full_name: str   = Field(..., min_length=3, max_length=200)
    birth_date: str  = Field(..., description="ISO date YYYY-MM-DD")
    nationality: str = Field(default="GQ", max_length=10)
    gender: Gender | None = None
    address: str | None = None
    city: str | None = None
    occupation: str | None = None
    doc_type: DocType = "dni"
    doc_number: str   = Field(..., min_length=2, max_length=50)
    doc_expiry: str | None = Field(default=None, description="ISO date YYYY-MM-DD")

    @field_validator("birth_date", "doc_expiry", mode="before")
    @classmethod
    def validate_date(cls, v: str | None) -> str | None:
        if v is None:
            return None
        try:
            date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"Fecha inválida: {v}. Formato esperado: YYYY-MM-DD")
        return v


# ── Paso 2: Datos completos del perfil económico ─────────────────
class KycPersonalDataRequest(BaseModel):
    full_name: str
    date_of_birth: str = Field(..., description="YYYY-MM-DD")
    place_of_birth: str | None = None
    nationality: str = "GQ"
    sex: Gender | None = None
    marital_status: MaritalStatus | None = None
    address: str | None = None
    city: str | None = None
    province: str | None = None
    country: str = "GQ"
    phone: str | None = None
    email: str | None = None
    profession: str | None = None
    employer: str | None = None
    monthly_income_range: IncomeRange | None = None
    source_of_funds: SourceOfFunds | None = None
    politically_exposed: bool = False
    pep_details: str | None = None


# ── Paso 3: Envío final ──────────────────────────────────────────
class KycSubmitRequest(BaseModel):
    # Datos personales (paso 1)
    full_name: str   = Field(..., min_length=3)
    birth_date: str
    nationality: str = "GQ"
    gender: Gender | None = None
    address: str | None = None
    city: str | None = None
    occupation: str | None = None
    # Perfil económico (paso 2)
    profession: str | None = None
    employer: str | None = None
    monthly_income_range: IncomeRange | None = None
    source_of_funds: SourceOfFunds | None = None
    politically_exposed: bool = False
    # Documento
    doc_type: DocType = "dni"
    doc_number: str   = Field(..., min_length=2)
    doc_expiry: str | None = None
    doc_front_url: str = Field(..., description="URL en Supabase Storage (ya subida)")
    doc_back_url: str | None = None
    selfie_url: str = Field(..., description="URL selfie en Supabase Storage")
    # Metadatos dispositivo
    device_info: dict = Field(default_factory=dict)


# ── Respuesta de estado ───────────────────────────────────────────
class KycRecordResponse(BaseModel):
    id: UUID
    status: str
    rejection_reason: str | None
    submitted_at: datetime | None
    reviewed_at: datetime | None
    full_name: str | None
    doc_type: str | None
    doc_number: str | None

    model_config = {"from_attributes": True}


class KycStatusResponse(BaseModel):
    kyc_status: str
    kyc_record: KycRecordResponse | None
    rejection_reason: str | None
    wallet_enabled: bool


# ── Respuesta de upload ───────────────────────────────────────────
class UploadResponse(BaseModel):
    success: bool
    url: str
    path: str
    doc_type: str


# ── Respuesta de submit ───────────────────────────────────────────
class KycSubmitResponse(BaseModel):
    success: bool
    kyc_id: UUID
    kyc_status: str
    message: str
