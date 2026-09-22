# EGChat KYC/AML Backend

API FastAPI para el sistema de verificación de identidad y cumplimiento AML del Monedero Digital EGChat.

**Cumplimiento normativo:** COBAC R-2023/01 · CEMAC N°02/24 · Ley N°2/2008 GQ  
**Socio bancario:** BANGE — Banco Nacional de Guinea Ecuatorial

---

## Arranque rápido (local)

```bash
# 1. Prerrequisitos
python --version     # 3.11+
pip install -r requirements.txt

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 3. Ejecutar migraciones de BD
cd ../
alembic upgrade head

# 4. Arrancar servidor de desarrollo
cd kyc_backend/
uvicorn app.main:app --reload --port 8001

# Swagger UI disponible en http://localhost:8001/docs (solo en DEBUG=true)
```

## Docker

```bash
# Desarrollo con hot-reload
docker compose up

# Build imagen de producción
docker build -t egchat-kyc-api:latest .
docker run -p 8001:8000 --env-file .env egchat-kyc-api:latest
```

## Deploy en Render

```bash
# Desde la raíz del repo
git push origin mobile

# O configurar auto-deploy en Render dashboard con render.yaml
```

---

## Estructura del proyecto

```
kyc_backend/
├── app/
│   ├── main.py           ← FastAPI app, CORS, rate limiter
│   ├── config.py         ← Settings (pydantic-settings)
│   ├── database.py       ← SQLAlchemy async engine
│   ├── models/           ← ORM (9 modelos)
│   ├── schemas/          ← Pydantic request/response
│   ├── routers/          ← Endpoints REST
│   │   ├── auth.py       ← POST /auth/login|logout|me
│   │   ├── kyc.py        ← GET|POST /kyc/*
│   │   ├── admin_kyc.py  ← GET|POST /admin/kyc/*
│   │   ├── aml.py        ← GET|POST /aml/*
│   │   └── webhooks.py   ← POST /webhooks/bange|anif
│   ├── services/
│   │   ├── kyc_service.py      ← Orquesta el submit completo
│   │   ├── decision_engine.py  ← Risk score + auto-decisión
│   │   ├── screening.py        ← OFAC/PEP/Adverse Media
│   │   ├── aml_service.py      ← Detección automática AML
│   │   ├── storage.py          ← Supabase Storage upload
│   │   └── notifications.py    ← Push al usuario
│   ├── auth/
│   │   ├── jwt.py              ← JWT HS256
│   │   ├── password.py         ← bcrypt
│   │   └── dependencies.py     ← get_current_admin, require_roles
│   └── core/
│       ├── audit.py            ← log_action (INMUTABLE)
│       ├── encryption.py       ← AES-256-GCM
│       └── exceptions.py       ← HTTPException custom
├── Dockerfile
├── docker-compose.yml
├── render.yaml
├── requirements.txt
└── .env.example
```

---

## Endpoints principales

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | /auth/login | — | Login admin → JWT |
| GET  | /kyc/status | User JWT | Estado KYC del usuario |
| POST | /kyc/submit | User JWT | Envío final formulario KYC |
| POST | /kyc/upload | User JWT | Subir foto de documento/selfie |
| GET  | /admin/kyc/pending | Admin JWT | Lista KYC pendientes |
| POST | /admin/kyc/{id}/review | COMPLIANCE | Aprobar/rechazar KYC |
| POST | /admin/kyc/{id}/bank-decision | BANGE | Decisión banco |
| GET  | /aml/transactions/flagged | Admin JWT | Transacciones sospechosas |
| POST | /aml/sar | COMPLIANCE | Crear SAR para ANIF |
| POST | /aml/sar/{id}/send | COMPLIANCE | Enviar SAR a ANIF |
| POST | /webhooks/bange | HMAC | Recibir decisión BANGE |
| POST | /webhooks/anif  | HMAC | Acuse de recibo ANIF |

---

## Motor de decisión KYC

```
score 0–30  → AUTO_APPROVED  (activa monedero inmediatamente)
score 31+   → MANUAL_REVIEW  (va al dashboard del revisor)
SANCTIONS   → BLOCKED        (bloqueo inmediato, sin manual)

Factores principales:
  +25 → Match en lista SANCTIONS (OFAC/UE/ONU)
  +20 → PEP detectado
  +20 → Liveness check fallido
  +15 → Nacionalidad FATF high-risk
  +15 → OCR confidence < 0.70
```

---

## Seguridad

- JWT HS256 con expiración 8h (admin) / 30d (usuario)
- Webhooks validados con HMAC-SHA256 + anti-replay (5 min)
- Campos sensibles cifrados AES-256-GCM en BD:
  - URLs de documentos e imágenes
  - Teléfono y email en kyc_personal_data
  - Número de documento en SAR
- `kyc_audit_log` INMUTABLE — triggers de BD bloquean UPDATE/DELETE
- Retención de datos: 10 años (COBAC Art. 23)

---

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | PostgreSQL async (Supabase) |
| `JWT_SECRET` | Mínimo 64 chars aleatorios |
| `ENCRYPTION_KEY` | 64 chars hex (32 bytes AES) |
| `SUPABASE_URL` | URL proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | service_role key (NO anon) |
| `BANGE_WEBHOOK_SECRET` | Compartido con BANGE para HMAC |

Ver `.env.example` para la lista completa.
