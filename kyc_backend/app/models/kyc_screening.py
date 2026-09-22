"""Modelo ORM — tabla kyc_screening_results."""
import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class KycScreeningResult(Base):
    __tablename__ = "kyc_screening_results"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("kyc_verifications.id", ondelete="CASCADE"), nullable=False
    )
    screening_type: Mapped[str] = mapped_column(String(30), nullable=False)
    provider: Mapped[str] = mapped_column(String(100), nullable=False, default="internal")
    provider_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)
    match_found: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    match_score: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    match_details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    reviewed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    false_positive: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    application: Mapped["KycApplication"] = relationship("KycApplication", back_populates="screening_results")
