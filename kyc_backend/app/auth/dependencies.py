"""
Dependencias FastAPI para autenticación y autorización.

Uso en routers:
    from app.auth.dependencies import get_current_admin, require_roles

    @router.get("/")
    async def endpoint(admin = Depends(get_current_admin)):
        ...

    @router.post("/review")
    async def review(admin = Depends(require_roles("COMPLIANCE_OFFICER","SUPER_ADMIN"))):
        ...
"""
from typing import Callable
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import decode_token, USER_TOKEN_TYPE, ADMIN_TOKEN_TYPE
from app.database import get_db
from app.models.admin_user import AdminUser
from app.models.user import User

_bearer = HTTPBearer(auto_error=True)

# ── Roles disponibles ─────────────────────────────────────────────
ALL_ROLES     = ("SUPER_ADMIN", "COMPLIANCE_OFFICER", "ANALYST", "BANK_VIEWER")
REVIEW_ROLES  = ("SUPER_ADMIN", "COMPLIANCE_OFFICER")
BANGE_ROLES   = ("SUPER_ADMIN", "BANK_VIEWER")
AML_ROLES     = ("SUPER_ADMIN", "COMPLIANCE_OFFICER")
READ_ROLES    = ("SUPER_ADMIN", "COMPLIANCE_OFFICER", "ANALYST", "BANK_VIEWER")


# ── Helper: extraer token del header ──────────────────────────────
def _extract_token(creds: HTTPAuthorizationCredentials) -> dict:
    try:
        return decode_token(creds.credentials)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "INVALID_TOKEN", "message": "Token inválido o expirado"},
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── Dependencia: admin autenticado ────────────────────────────────
async def get_current_admin(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> AdminUser:
    payload = _extract_token(creds)

    if payload.get("type") != ADMIN_TOKEN_TYPE:
        raise HTTPException(status_code=403, detail={"error": "FORBIDDEN", "message": "Token de usuario no válido para esta ruta"})

    admin_id = payload.get("sub")
    if not admin_id:
        raise HTTPException(status_code=401, detail={"error": "INVALID_TOKEN", "message": "Token sin subject"})

    result = await db.execute(select(AdminUser).where(AdminUser.id == UUID(admin_id)))
    admin = result.scalar_one_or_none()

    if not admin or not admin.is_active:
        raise HTTPException(status_code=401, detail={"error": "ADMIN_NOT_FOUND", "message": "Admin no encontrado o inactivo"})

    return admin


# ── Factory: require_roles(*roles) ────────────────────────────────
def require_roles(*roles: str) -> Callable:
    """
    Devuelve una dependencia que valida que el admin tenga uno de los roles indicados.
    Uso: Depends(require_roles("SUPER_ADMIN", "COMPLIANCE_OFFICER"))
    """
    async def _check(admin: AdminUser = Depends(get_current_admin)) -> AdminUser:
        if admin.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "INSUFFICIENT_ROLE",
                    "message": f"Se requiere uno de los roles: {', '.join(roles)}",
                    "your_role": admin.role,
                },
            )
        return admin
    return _check


# ── Dependencia: usuario de la app (JWT del Render API existente) ─
async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    payload = _extract_token(creds)

    # Aceptar tanto tokens tipo "user" como los del Render API (sin campo "type")
    token_type = payload.get("type")
    if token_type == ADMIN_TOKEN_TYPE:
        raise HTTPException(status_code=403, detail={"error": "FORBIDDEN", "message": "Token de admin no válido aquí"})

    user_id = payload.get("sub") or payload.get("id")
    if not user_id:
        raise HTTPException(status_code=401, detail={"error": "INVALID_TOKEN", "message": "Token sin subject"})

    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=401, detail={"error": "USER_NOT_FOUND", "message": "Usuario no encontrado"})

    return user


# ── Helper: extraer IP del request ───────────────────────────────
def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
