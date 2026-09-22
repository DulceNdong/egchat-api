"""Schemas Pydantic — Admin KYC (revisores internos y BANGE)."""
from __future__ import annotations
from datetime import datetime
from uuid import UUID
from typing import Literal
from pydantic import BaseModel, Field


AdminDecision = Literal["approved", "APPROVED", "rejected", "REJECTED", "BLOCKED", "suspended"]
BankDecision  = Literal["APPROVED", "REJECTED"]


# ── Listado paginado ──────────────────────────────────────────────
class KycListItem(BaseModel):
    application_id: UUID
    session_id: str | None
    status: str
    risk_level: str
    risk_score: int
    bank_decision: str | None
    submitted_at: datetime | None
    created_at: datetime
    user_phone: str | None
    user_status: str | None
    full_name: str | None
    nationality: str | None
    document_type: str | None
    ocr_confidence: float | None
    face_match_score: float | None
    liveness_passed: bool | None
    screening_hits: int

    model_config = {"from_attributes": True}


class KycListResponse(BaseModel):
    items: list[KycListItem]
    total: int
    page: int
    page_size: int
    pages: int


# ── Detalle completo ──────────────────────────────────────────────
class ScreeningResultResponse(BaseModel):
    id: UUID
    screening_type: str
    provider: str
    match_found: bool
    match_score: float | None
    match_details: dict
    reviewed: bool
    false_positive: bool | None

    model_config = {"from_attributes": True}


class KycDetailResponse(BaseModel):
    id: UUID
    session_id: str | None
    status: str
    risk_level: str
    risk_score: int
    bank_decision: str | None
    bank_notes: str | None
    bank_decision_at: datetime | None
    rejection_reason: str | None
    reviewer_notes: str | None
    reviewed_at: datetime | None
    submitted_at: datetime | None
    created_at: datetime
    # usuario
    user_id: UUID
    user_phone: str | None
    # personal data
    full_name: str | None
    nationality: str | None
    birth_date: str | None
    profession: str | None
    source_of_funds: str | None
    politically_exposed: bool | None
    # documentos
    doc_type: str | None
    doc_number: str | None
    doc_front_url: str | None
    doc_back_url: str | None
    selfie_url: str | None
    ocr_confidence: float | None
    face_match_score: float | None
    liveness_passed: bool | None
    # screening
    screening_results: list[ScreeningResultResponse]

    model_config = {"from_attributes": True}


# ── Revisión interna ──────────────────────────────────────────────
class ReviewRequest(BaseModel):
    decision: AdminDecision
    rejection_reason: str | None = Field(
        default=None,
        description="Obligatorio cuando decision es 'rejected' o 'REJECTED'"
    )
    notes: str | None = None


class ReviewResponse(BaseModel):
    success: bool
    application_id: UUID
    new_status: str
    message: str


# ── Decisión BANGE ────────────────────────────────────────────────
class BankDecisionRequest(BaseModel):
    decision: BankDecision
    notes: str | None = None


class BankDecisionResponse(BaseModel):
    success: bool
    application_id: UUID
    bank_decision: str
    message: str


# ── Estadísticas dashboard ────────────────────────────────────────
class KycStatsResponse(BaseModel):
    total_applications: int
    pending_review: int
    approved_today: int
    rejected_today: int
    avg_risk_score: float
    high_risk_count: int
    screening_hits_unreviewed: int
    sars_overdue: int
