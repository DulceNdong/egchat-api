"""Modelo ORM — tabla kyc_verifications (alias kyc_applications en el spec)."""
import uuid
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class KycApplication(Base):
    __tablename__ = "kyc_verifications"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft")
    risk_level: Mapped[str] = mapped_column(String(10), nullable=False, default="low")
    risk_score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Datos de identidad (campos heredados de kyc_tables.sql)
    full_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    birth_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    nationality: Mapped[str] = mapped_column(String(10), nullable=False, default="GQ")
    gender: Mapped[str | None] = mapped_column(String(1), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(Text, nullable=True)
    occupation: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Documento
    doc_type: Mapped[str] = mapped_column(String(30), nullable=False, default="dni")
    doc_number: Mapped[str | None] = mapped_column(Text, nullable=True)
    doc_expiry: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    doc_front_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    doc_back_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    selfie_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Revisión interna
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewer_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_by_admin: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Decisión BANGE
    bank_decision: Mapped[str | None] = mapped_column(String(20), nullable=True)
    bank_decision_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    bank_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    bank_reviewer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )

    # AML
    device_info: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relaciones
    user: Mapped["User"] = relationship("User", back_populates="kyc_application")
    reviewer: Mapped["AdminUser | None"] = relationship(
        "AdminUser", foreign_keys=[reviewed_by_admin], back_populates="reviewed_applications"
    )
    bank_reviewer: Mapped["AdminUser | None"] = relationship(
        "AdminUser", foreign_keys=[bank_reviewer_id], back_populates="bank_reviewed_applications"
    )
    personal_data: Mapped["KycPersonalData | None"] = relationship(
        "KycPersonalData", back_populates="application", uselist=False
    )
    documents: Mapped[list["KycDocument"]] = relationship(
        "KycDocument", foreign_keys="KycDocument.application_id", back_populates="application"
    )
    screening_results: Mapped[list["KycScreeningResult"]] = relationship("KycScreeningResult", back_populates="application")
    sars: Mapped[list["SuspiciousActivityReport"]] = relationship("SuspiciousActivityReport", back_populates="application")
