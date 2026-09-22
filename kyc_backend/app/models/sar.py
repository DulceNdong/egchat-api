"""Modelo ORM — tabla suspicious_activity_reports."""
import uuid
from datetime import datetime
from decimal import Decimal
from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class SuspiciousActivityReport(Base):
    __tablename__ = "suspicious_activity_reports"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("kyc_verifications.id", ondelete="SET NULL"), nullable=True
    )
    transaction_ids: Mapped[list] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False, default=list)
    reported_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("admin_users.id", ondelete="RESTRICT"), nullable=False
    )
    report_type: Mapped[str] = mapped_column(String(30), nullable=False, default="SAR")
    description: Mapped[str] = mapped_column(Text, nullable=False)
    indicators: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    subject_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject_id_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    subject_id_num: Mapped[str | None] = mapped_column(Text, nullable=True)    # cifrado AES-256
    amount_involved: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="XAF")
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="DRAFT")
    anif_reference: Mapped[str | None] = mapped_column(String(100), nullable=True)
    anif_response: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    sif_payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    application: Mapped["KycApplication | None"] = relationship("KycApplication", back_populates="sars")
    reporter: Mapped["AdminUser"] = relationship("AdminUser", back_populates="sars")
