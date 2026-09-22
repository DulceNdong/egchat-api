"""Modelo ORM — tabla users (ya existe en Supabase, mapeamos sin recrear)."""
import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    phone: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    full_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Status KYC
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="PENDING_KYC")
    wallet_kyc_status: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    wallet_kyc_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    wallet_kyc_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    wallet_kyc_reject_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relaciones
    kyc_application: Mapped["KycApplication | None"] = relationship("KycApplication", back_populates="user", uselist=False)
    transactions: Mapped[list["Transaction"]] = relationship("Transaction", back_populates="user")
