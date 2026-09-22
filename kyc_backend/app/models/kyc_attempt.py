"""Modelo ORM — tabla kyc_attempts (rate-limit por user_id)."""
import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import INET, UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class KycAttempt(Base):
    __tablename__ = "kyc_attempts"
    __table_args__ = {"extend_existing": True}

    id:            Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id:       Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id:    Mapped[uuid.UUID|None] = mapped_column(UUID(as_uuid=True), nullable=True)
    attempted_at:  Mapped[datetime]       = mapped_column(DateTime(timezone=True), server_default=func.now())
    ip_address:    Mapped[str|None]       = mapped_column(INET, nullable=True)
    user_agent:    Mapped[str|None]       = mapped_column(Text, nullable=True)
    success:       Mapped[bool]           = mapped_column(Boolean, nullable=False, default=False)
    blocked_reason:Mapped[str|None]       = mapped_column(String(200), nullable=True)
