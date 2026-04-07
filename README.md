# EGCHAT API

Backend de EGCHAT con Express + Supabase.

## Variables de entorno requeridas en Render:

```
SUPABASE_URL=https://fjtoxjcuyfapeprniink.supabase.co
SUPABASE_SERVICE_KEY=<tu service_role key>
JWT_SECRET=egchat_secret_2026
```

## Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET  /api/wallet/balance`
- `POST /api/wallet/deposit`
- `POST /api/wallet/withdraw`
- `POST /api/lia/chat`
