# ══════════════════════════════════════════════════════════════════
# EGChat KYC/AML Backend — Dockerfile (multi-stage)
# Stage 1: builder — instala deps con pip
# Stage 2: runtime — imagen mínima sin herramientas de build
# ══════════════════════════════════════════════════════════════════

# ── Stage 1: Builder ──────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# Instalar dependencias del sistema mínimas para compilar psycopg2 / cryptography
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copiar solo requirements para aprovechar caché de capas
COPY requirements.txt .

# Instalar en directorio separado (para copiar al runtime)
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: Runtime ──────────────────────────────────────────────
FROM python:3.11-slim

LABEL maintainer="EGChat <dev@egchat.gq>"
LABEL description="EGChat KYC/AML Backend API"
LABEL version="1.0.0"

# Usuario no root para mayor seguridad
RUN groupadd -r egchat && useradd -r -g egchat egchat

WORKDIR /app

# Deps del sistema mínimas en runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Copiar packages instalados desde builder
COPY --from=builder /install /usr/local

# Copiar código fuente
COPY --chown=egchat:egchat . .

# Variables de entorno de producción
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PORT=8000

# Cambiar a usuario no root
USER egchat

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# Arrancar con Uvicorn — workers calculados por CPU en producción
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--log-level", "info", \
     "--access-log"]
