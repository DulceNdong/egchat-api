"""Router /auth — login/logout/me para admins."""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt import create_admin_token
from app.auth.password import verify_password
from app.auth.dependencies import get_current_admin
from app.database import get_db
from app.models.admin_user import AdminUser
from app.schemas.auth import AdminLoginRequest, AdminMeResponse, TokenResponse
from app.core.audit import log_action

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
async def admin_login(body: AdminLoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(AdminUser).where(AdminUser.email == body.email, AdminUser.is_active == True)
    )
    admin = result.scalar_one_or_none()

    if not admin or not verify_password(body.password, admin.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "INVALID_CREDENTIALS", "message": "Email o contraseña incorrectos"},
        )

    token, expires_in = create_admin_token(admin.id, admin.role, admin.entity)

    # Actualizar last_login
    admin.last_login = datetime.now(tz=timezone.utc)
    await db.commit()

    await log_action(db, action="ADMIN_LOGIN", admin_id=admin.id,
                     details={"email": admin.email, "role": admin.role})

    return TokenResponse(
        access_token=token,
        expires_in=expires_in,
        admin_id=admin.id,
        role=admin.role,
        entity=admin.entity,
    )


@router.post("/logout", status_code=204)
async def admin_logout(
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    await log_action(db, action="ADMIN_LOGOUT", admin_id=admin.id,
                     details={"email": admin.email})
    # JWT es stateless — el cliente debe descartar el token.
    # En producción se puede añadir una blocklist en Redis.
    return None


@router.get("/me", response_model=AdminMeResponse)
async def admin_me(admin: AdminUser = Depends(get_current_admin)):
    return admin
