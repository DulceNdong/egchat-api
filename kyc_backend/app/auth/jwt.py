"""
Creación y verificación de JWT para admins y usuarios de la app.
- Admin: HS256, expira en settings.jwt_expire_admin_hours
- User:  HS256, expira en settings.jwt_expire_user_days (compatibilidad con Render API)
"""
from datetime import datetime, timedelta, timezone
from uuid import UUID
from jose import JWTError, jwt
from app.config import get_settings

settings = get_settings()

# ── Claims internos ───────────────────────────────────────────────
ADMIN_TOKEN_TYPE = "admin"
USER_TOKEN_TYPE  = "user"


def create_admin_token(admin_id: UUID, role: str, entity: str) -> tuple[str, int]:
    """Devuelve (token, expires_in_seconds)."""
    expires_seconds = settings.jwt_expire_admin_hours * 3600
    exp = datetime.now(tz=timezone.utc) + timedelta(seconds=expires_seconds)
    payload = {
        "sub":    str(admin_id),
        "role":   role,
        "entity": entity,
        "type":   ADMIN_TOKEN_TYPE,
        "exp":    exp,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, expires_seconds


def create_user_token(user_id: UUID) -> tuple[str, int]:
    """Token para usuarios de la app (compatibilidad con el Render API existente)."""
    expires_seconds = settings.jwt_expire_user_days * 86400
    exp = datetime.now(tz=timezone.utc) + timedelta(seconds=expires_seconds)
    payload = {
        "sub":  str(user_id),
        "type": USER_TOKEN_TYPE,
        "exp":  exp,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, expires_seconds


def decode_token(token: str) -> dict:
    """
    Decodifica y valida el JWT.
    Lanza JWTError si es inválido o expirado.
    """
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
