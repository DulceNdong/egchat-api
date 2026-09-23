"""Modelo ORM — tabla admin_users."""
import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class AdminUser(Base):
    __tablename__ = "admin_users"
    __table_args__ = {"extend_existing": True}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    entity: Mapped[str] = mapped_column(String(30), nullable=False, default="OUR_COMPANY")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relaciones
    reviewed_applications: Mapped[list["KycApplication"]] = relationship(
        "KycApplication", foreign_keys="KycApplication.reviewed_by_admin", back_populates="reviewer"
    )
    bank_reviewed_applications: Mapped[list["KycApplication"]] = relationship(
        "KycApplication", foreign_keys="KycApplication.bank_reviewer_id", back_populates="bank_reviewer"
    )
    sars: Mapped[list["SuspiciousActivityReport"]] = relationship("SuspiciousActivityReport", back_populates="reporter")
