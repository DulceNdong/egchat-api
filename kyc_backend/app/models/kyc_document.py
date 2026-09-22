"""Modelo ORM — tabla kyc_documents."""
import uuid
from datetime import date, datetime
from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class KycDocument(Base):
    __tablename__ = "kyc_documents"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("kyc_verifications.id", ondelete="CASCADE"), nullable=True
    )
    kyc_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("kyc_verifications.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    doc_type: Mapped[str | None] = mapped_column(String(30), nullable=True)          # tipo archivo (doc_front/selfie)
    document_type: Mapped[str | None] = mapped_column(String(30), nullable=True)     # DNI/PASSPORT/etc
    document_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    file_url: Mapped[str | None] = mapped_column(Text, nullable=True)                # URL original
    front_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)         # cifrado AES-256
    back_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)          # cifrado AES-256
    selfie_url: Mapped[str | None] = mapped_column(Text, nullable=True)              # cifrado AES-256
    mime_type: Mapped[str] = mapped_column(String(50), nullable=False, default="image/jpeg")
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Métricas de verificación automática
    ocr_confidence: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    face_match_score: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    liveness_passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    liveness_score: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    ocr_raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    application: Mapped["KycApplication | None"] = relationship(
        "KycApplication", foreign_keys=[application_id], back_populates="documents"
    )
