"""Schemas Pydantic — Auth admin."""
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, EmailStr, field_validator


class AdminLoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def password_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("La contraseña no puede estar vacía")
        return v


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int       # segundos
    admin_id: UUID
    role: str
    entity: str


class AdminMeResponse(BaseModel):
    id: UUID
    email: str
    role: str
    entity: str
    is_active: bool
    last_login: datetime | None

    model_config = {"from_attributes": True}
