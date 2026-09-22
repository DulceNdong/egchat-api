# Migraciones Alembic — EGChat KYC/AML

## Configuración rápida

```bash
# 1. Instalar dependencias
pip install -r ../requirements-alembic.txt

# 2. Configurar variables de entorno (o crear .env en /server)
export DATABASE_URL="postgresql://usuario:password@host:5432/egchat_kyc"
# O en Supabase:
export DATABASE_URL="postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres"

# 3. Ver estado de migraciones
alembic current

# 4. Aplicar todas las migraciones pendientes
alembic upgrade head

# 5. Aplicar solo la migración 008
alembic upgrade 008kyc_aml

# 6. Revertir la última migración (rollback)
alembic downgrade -1

# 7. Generar SQL sin ejecutar (modo offline — para revisión)
alembic upgrade 008kyc_aml --sql > /tmp/008_review.sql
```

## Estructura

```
alembic/
  env.py              ← Configuración de conexión
  script.py.mako      ← Template para nuevas migraciones
  README.md           ← Este archivo
  versions/
    008_kyc_aml_complete.py   ← Migración KYC/AML completa
```

## Tablas creadas por 008

| Tabla | Descripción |
|---|---|
| `admin_users` | Revisores internos y BANGE (roles + entidades) |
| `kyc_personal_data` | Datos personales separados (minimización) |
| `kyc_screening_results` | Resultados OFAC/PEP/ADVERSE_MEDIA |
| `kyc_audit_log` | Log INMUTABLE — 10 años (COBAC Art. 23) |
| `suspicious_activity_reports` | SAR para ANIF (deadline 72h) |

## Tablas modificadas por 008

| Tabla | Columnas añadidas |
|---|---|
| `users` | `status`, `wallet_kyc_status`, `wallet_kyc_*` |
| `kyc_verifications` | `session_id`, `risk_score`, `bank_decision`, `bank_notes`, `bank_reviewer_id` |
| `kyc_documents` | `ocr_confidence`, `face_match_score`, `liveness_passed`, `ocr_raw_data` |
| `transactions` | `flagged`, `flag_reason`, `flag_type`, `currency`, `aml_*` |

## Notas de cumplimiento

- `kyc_audit_log` tiene triggers que bloquean cualquier UPDATE o DELETE
- `suspicious_activity_reports.deadline_at` = `detected_at + 72h` (Ley N°2/2008 Art. 8)
- Campos cifrados en producción: `kyc_documents.(front|back|selfie)_url`,
  `kyc_personal_data.(phone|email)`, `suspicious_activity_reports.subject_id_num`
- Retención mínima: 10 años (COBAC R-2023/01 Art. 23)
