# FORKSY

Three-sided food delivery marketplace (customers, restaurants, drivers).

- `backend/` - NestJS 11 + TypeORM + PostgreSQL API (all modules wired; Swagger at `/docs`)
- `admin/` - Admin Console (React, WowDash template)
- `docs/` - `ARCHITECTURE.md` build contract and `api/*.md` route references
- `tools/pg/` - embedded Postgres launcher for local dev (no Docker needed)

## Run locally

```bash
# 1. database (port 5432, user/pass postgres/postgres, db forksy)
cd tools/pg && npm install && node start.mjs

# 2. backend (copy backend/.env.example to backend/.env first)
cd backend && npm install && npm run seed && npm run start:dev   # http://localhost:4000/api/v1

# 3. admin console
cd admin && npm install && npm start                             # http://localhost:3000
```

Demo password for seeded accounts: `Demo@12345` (e.g. `customer1@demo.forksy.ca`, `driver1@demo.forksy.ca`, `owner1@demo-restaurant.ca`).
Admin login is set by `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD` in `backend/.env`.
