"""
Alembic env.py — EGChat KYC/AML
Lee la URL de conexión desde variables de entorno para no exponer credenciales.
"""
import os
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context

# ── Cargar .env si está disponible (desarrollo local) ─────────────
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass  # python-dotenv no instalado — usar variables del sistema

# ── Configuración Alembic ─────────────────────────────────────────
config = context.config

# Leer configuración del logging desde alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ── URL de base de datos desde variables de entorno ───────────────
def get_db_url() -> str:
    """
    Construye la URL de conexión desde variables de entorno.
    Prioridad: DATABASE_URL > componentes individuales
    """
    url = os.getenv("DATABASE_URL")
    if url:
        # Supabase devuelve postgres:// — SQLAlchemy 2.x requiere postgresql://
        return url.replace("postgres://", "postgresql+psycopg2://", 1)

    # Componentes individuales
    user     = os.getenv("DB_USER",     "postgres")
    password = os.getenv("DB_PASSWORD", "")
    host     = os.getenv("DB_HOST",     "localhost")
    port     = os.getenv("DB_PORT",     "5432")
    name     = os.getenv("DB_NAME",     "egchat_kyc")
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"


# Sobreescribir la URL en la configuración
config.set_main_option("sqlalchemy.url", get_db_url())

# ── Metadata para autogeneración (opcional) ───────────────────────
# Si en el futuro defines modelos SQLAlchemy, impórtalos aquí:
# from app.models import Base
# target_metadata = Base.metadata
target_metadata = None


# ── Modos de ejecución ────────────────────────────────────────────
def run_migrations_offline() -> None:
    """
    Modo offline: genera SQL sin conectarse a la BD.
    Útil para revisión antes de ejecutar en producción.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    Modo online: se conecta directamente a la BD y ejecuta las migraciones.
    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
