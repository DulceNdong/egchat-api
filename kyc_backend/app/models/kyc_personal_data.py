"""Modelo ORM — tabla kyc_personal_data."""
import uuid
from datetime import date, datetime
from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class KycPersonalData(Base):
    __tablename__ = "kyc_personal_data"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("kyc_verifications.id", ondelete="CASCADE"),
        nullable=False, unique=True
    )
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    date_of_birth: Mapped[date] = mapped_column(Date, nullable=False)
    place_of_birth: Mapped[str | None] = mapped_column(Text, nullable=True)
    nationality: Mapped[str] = mapped_column(String(10), nullable=False, default="GQ")
    sex: Mapped[str | None] = mapped_column(String(1), nullable=True)
    marital_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(Text, nullable=True)
    province: Mapped[str | None] = mapped_column(Text, nullable=True)
    country: Mapped[str] = mapped_column(String(10), nullable=False, default="GQ")
    phone: Mapped[str | None] = mapped_column(Text, nullable=True)   # cifrado AES-256
    email: Mapped[str | None] = mapped_column(Text, nullable=True)   # cifrado AES-256
    profession: Mapped[str | None] = mapped_column(Text, nullable=True)
    employer: Mapped[str | None] = mapped_column(Text, nullable=True)
    monthly_income_range: Mapped[str | None] = mapped_column(String(30), nullable=True)
    source_of_funds: Mapped[str | None] = mapped_column(String(50), nullable=True)
    politically_exposed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    pep_details: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    application: Mapped["KycApplication"] = relationship("KycApplication", back_populates="personal_data")
