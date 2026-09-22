"""Schemas Pydantic — AML: flagging de transacciones + SAR."""
from __future__ import annotations
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Literal
from pydantic import BaseModel, Field

FlagType      = Literal["STRUCTURING","UNUSUAL_PATTERN","HIGH_RISK_COUNTRY",
                         "PEP_INVOLVED","SANCTIONS_HIT","VELOCITY",
                         "THRESHOLD_BREACH","MANUAL"]
SarStatus     = Literal["DRAFT","PENDING_REVIEW","APPROVED","SENT_TO_ANIF","ACKNOWLEDGED","CLOSED"]
ReportType    = Literal["SAR","CTR","STR"]


# ── Transacciones flaggeadas ──────────────────────────────────────
class FlagTransactionRequest(BaseModel):
    flag_type: FlagType
    flag_reason: str = Field(..., min_length=10)


class FlagTransactionResponse(BaseModel):
    success: bool
    transaction_id: UUID
    flag_type: str
    message: str


class FlaggedTransactionItem(BaseModel):
    id: UUID
    user_id: UUID
    type: str
    amount: Decimal
    currency: str
    flag_type: str | None
    flag_reason: str | None
    flagged_at: datetime | None
    aml_reviewed: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class FlaggedTransactionsResponse(BaseModel):
    items: list[FlaggedTransactionItem]
    total: int
    page: int
    page_size: int


class ReviewTransactionRequest(BaseModel):
    notes: str | None = None
    clear_flag: bool = False    # TRUE → quita el flag tras revisión


# ── SAR (Suspicious Activity Report) ─────────────────────────────
class SarCreateRequest(BaseModel):
    application_id: UUID | None = None
    transaction_ids: list[UUID] = Field(default_factory=list)
    report_type: ReportType = "SAR"
    description: str = Field(..., min_length=20)
    indicators: list[str] = Field(
        default_factory=list,
        description="e.g. ['structuring', 'pep_involved']"
    )
    subject_name: str | None = None
    subject_id_type: str | None = None
    subject_id_num: str | None = None    # se cifrará AES-256 en servicio
    amount_involved: Decimal | None = None
    currency: str = "XAF"


class SarUpdateRequest(BaseModel):
    description: str | None = None
    indicators: list[str] | None = None
    subject_name: str | None = None
    amount_involved: Decimal | None = None
    status: SarStatus | None = None
    anif_reference: str | None = None


class SarResponse(BaseModel):
    id: UUID
    application_id: UUID | None
    transaction_ids: list[UUID]
    report_type: str
    description: str
    indicators: list
    status: str
    amount_involved: Decimal | None
    currency: str
    anif_reference: str | None
    detected_at: datetime
    deadline_at: datetime | None    # detected_at + 72h
    sent_at: datetime | None
    created_at: datetime
    reported_by_email: str | None = None
    overdue: bool = False

    model_config = {"from_attributes": True}


class SarListResponse(BaseModel):
    items: list[SarResponse]
    total: int
    page: int
    page_size: int


class SarSendResponse(BaseModel):
    success: bool
    sar_id: UUID
    anif_reference: str | None
    message: str
