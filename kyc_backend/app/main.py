"""
EGChat KYC/AML — FastAPI Application Entry Point
Cumplimiento: COBAC R-2023/01 · CEMAC N°02/24 · Ley N°2/2008 GQ
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import get_settings
from app.core.exceptions import KYCException
# Routers v0 (compatibilidad hacia atrás)
from app.routers import auth, kyc, admin_kyc, aml, webhooks
# Routers v1 (orquestador KYC multi-paso)
from app.routers.kyc_v1 import router as kyc_v1_router
from app.routers.admin_kyc_v2 import router as admin_kyc_v2_router

# ── Logging estructurado JSON ─────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG if get_settings().debug else logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
logger = logging.getLogger("egchat.kyc")

settings = get_settings()

# ── Rate limiter global (por IP) ─────────────────────────────────
# Rate limiting por user_id está implementado en kyc_rate_limit.py
limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        '{"event":"startup","version":"%s","env":"%s"}',
        settings.app_version, settings.environment,
    )
    yield
    logger.info('{"event":"shutdown"}')


# ── Aplicación ────────────────────────────────────────────────────
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description=(
        "API KYC/AML para el Monedero Digital EGChat. "
        "Operado en alianza con BANGE bajo licencia BEAC/COBAC.\n\n"
        "**v1** — Orquestador multi-paso con pipeline completo (OCR + biometría + liveness)\n"
        "**v0** — Endpoints legacy (compatibilidad)"
    ),
    lifespan=lifespan,
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
)

# ── Middlewares ───────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "Idempotency-Key"],
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore


# ── Manejadores de error globales ─────────────────────────────────
@app.exception_handler(KYCException)
async def kyc_exception_handler(request: Request, exc: KYCException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.code, "message": exc.message, "details": exc.details},
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception("Error no controlado: %s", exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": "INTERNAL_ERROR", "message": "Error interno del servidor"},
    )


# ══════════════════════════════════════════════════════════════════
# Routers v1 — Orquestador KYC multi-paso (PRODUCCIÓN)
# ══════════════════════════════════════════════════════════════════
app.include_router(
    kyc_v1_router,
    prefix="/api/v1/kyc",
    tags=["KYC v1 — Orquestador multi-paso"],
)
app.include_router(
    admin_kyc_v2_router,
    prefix="/api/v1/admin/kyc",
    tags=["Admin KYC v1 — request-info, block, approve, reject, audit"],
)

# ══════════════════════════════════════════════════════════════════
# Routers v0 — Legacy (compatibilidad con app móvil existente)
# ══════════════════════════════════════════════════════════════════
app.include_router(auth.router,      prefix="/auth",       tags=["Auth"])
app.include_router(kyc.router,       prefix="/kyc",        tags=["KYC v0 — Legacy"])
app.include_router(admin_kyc.router, prefix="/admin/kyc",  tags=["Admin KYC v0 — Legacy"])
app.include_router(aml.router,       prefix="/aml",        tags=["AML"])
app.include_router(webhooks.router,  prefix="/webhooks",   tags=["Webhooks"])


# ── Health check ──────────────────────────────────────────────────
@app.get("/health", tags=["Sistema"])
async def health():
    return {
        "status":  "ok",
        "version": settings.app_version,
        "env":     settings.environment,
        "routers": {
            "v1_kyc":       "/api/v1/kyc",
            "v1_admin_kyc": "/api/v1/admin/kyc",
            "v0_legacy":    "/kyc, /admin/kyc, /aml, /webhooks",
        },
    }


# ── Redirección informativa v0 → v1 ──────────────────────────────
@app.get("/api/v1", tags=["Sistema"])
async def api_v1_info():
    return {
        "message":   "EGChat KYC/AML API v1 — Orquestador multi-paso",
        "endpoints": {
            "init":     "POST /api/v1/kyc/init",
            "personal": "POST /api/v1/kyc/{session_id}/personal",
            "document": "POST /api/v1/kyc/{session_id}/document",
            "selfie":   "POST /api/v1/kyc/{session_id}/selfie",
            "financial":"POST /api/v1/kyc/{session_id}/financial",
            "consent":  "POST /api/v1/kyc/{session_id}/consent",
            "submit":   "POST /api/v1/kyc/{session_id}/submit",
            "status":   "GET  /api/v1/kyc/{session_id}/status",
            "admin": {
                "pending":      "GET  /api/v1/admin/kyc/pending",
                "detail":       "GET  /api/v1/admin/kyc/{id}",
                "approve":      "POST /api/v1/admin/kyc/{id}/approve",
                "reject":       "POST /api/v1/admin/kyc/{id}/reject",
                "request_info": "POST /api/v1/admin/kyc/{id}/request-info",
                "block":        "POST /api/v1/admin/kyc/{id}/block",
                "audit":        "GET  /api/v1/admin/kyc/{id}/audit",
            },
        },
    }
