"""
Configuración centralizada — EGChat KYC/AML Backend
Lee todas las variables de entorno mediante pydantic-settings.
"""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── App ───────────────────────────────────────────────────────
    app_name: str = "EGChat KYC/AML API"
    app_version: str = "1.0.0"
    debug: bool = False
    environment: str = "production"    # development | staging | production

    # ── Base de datos ─────────────────────────────────────────────
    database_url: str                  # postgresql+asyncpg://user:pass@host/db

    # ── JWT ───────────────────────────────────────────────────────
    jwt_secret: str                    # mínimo 32 chars aleatorios
    jwt_algorithm: str = "HS256"
    jwt_expire_admin_hours: int = 8    # sesiones admin cortas
    jwt_expire_user_days: int = 30     # sesiones usuario app

    # ── Cifrado AES-256 ───────────────────────────────────────────
    encryption_key: str                # 32 bytes en hex (64 chars hex)

    # ── Supabase ──────────────────────────────────────────────────
    supabase_url: str
    supabase_service_key: str          # service_role key (NO anon)
    supabase_kyc_bucket: str = "kyc-docs"

    # ── BANGE Webhook ─────────────────────────────────────────────
    bange_webhook_secret: str          # HMAC-SHA256 secret compartido con BANGE
    bange_api_url: str = ""            # URL API BANGE para enviar notificaciones

    # ── ANIF (reportes SIF) ───────────────────────────────────────
    anif_api_url: str = ""
    anif_api_key: str = ""

    # ── Rate limiting ─────────────────────────────────────────────
    rate_limit_upload: str = "10/minute"
    rate_limit_submit: str = "5/minute"

    # ── CORS ──────────────────────────────────────────────────────
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
        "https://egchat.gq",
        "https://app.egchat.gq",
    ]

    # ── Umbrales AML ──────────────────────────────────────────────
    aml_ctr_threshold_xaf: int = 5_000_000    # CTR obligatorio CEMAC
    aml_structuring_window_hours: int = 24
    aml_structuring_count: int = 3            # N operaciones < umbral en ventana

    # ── Rate limiting KYC por user_id ─────────────────────────────
    kyc_max_attempts_per_day: int = 5         # intentos /init por usuario/24h
    kyc_attempt_window_hours: int = 24

    # ── Timeouts del pipeline KYC (segundos) ─────────────────────
    kyc_ocr_timeout: int = 15
    kyc_biometry_timeout: int = 15
    kyc_liveness_timeout: int = 10
    kyc_screening_timeout: int = 15

    # ── SmileID ───────────────────────────────────────────────────
    smile_id_partner_id: str = ""
    smile_id_api_key: str = ""
    smile_id_env: str = "sandbox"         # sandbox | production

    # ── PaddleOCR (fallback local) ────────────────────────────────
    paddle_ocr_lang: str = ""             # vacío = no usar PaddleOCR
    paddle_ocr_use_gpu: bool = False

    # ── Screening externo ─────────────────────────────────────────
    screening_provider_url: str = ""
    screening_api_key: str = ""

    # ── ANIF webhook secret (puede diferir del BANGE) ────────────
    anif_webhook_secret: str = ""         # si vacío, usa bange_webhook_secret


@lru_cache
def get_settings() -> Settings:
    return Settings()
