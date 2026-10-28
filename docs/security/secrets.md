# FortiX Secrets, Environment Flags & Credential Rotation Guide

FortiX separates **plain runtime configuration flags**, **locally generated cryptographic secrets**, and **infrastructure connection credentials**. None of the application flags or cryptographic keys require paid third-party subscriptions—they are configured or generated locally on your machine for free.

> **Security Rule**: Never commit `.env` to Git, and never paste live replacement passwords, database URLs with credentials, or tokens into chat prompts, issues, or logs.

---

## 1. Where Every Environment Variable Comes From (100% Free)

| Variable | Type | Free Value / How to Get It |
| :--- | :--- | :--- |
| `STRICT_PERSISTENT_DB` | Boolean Flag | Plain text setting you choose: `true` when connected to real PostgreSQL (Docker or Supabase); `false` for standalone local in-memory mode. |
| `START_INTERNAL_WORKER` | Boolean Flag | Plain text setting: `true` when running a single-process server (`npm run dev`); `false` in multi-container `docker-compose.yml` where the `worker` container runs separately. |
| `START_DEMO_API` | Boolean Flag | Plain text setting: `true` in local development to start the demo upstream target on port `3001`; `false` in production/staging. |
| `REDIS_FAILURE_BEHAVIOR` | Policy Mode | Plain text setting: `fail-closed` (recommended security default; blocks rate-limited traffic if Redis is unreachable) or `fail-open` (development only). |
| `JWT_SECRET` | Local Secret | **100% Free — Generated offline on your computer** (minimum 32 characters, high entropy). Generated automatically by `npm run setup:local` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `ENCRYPTION_KEY` | Local Secret | **100% Free — Generated offline on your computer** (32 bytes / 64 hex characters for AES-256). Generated automatically by `npm run setup:local` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `POSTGRES_USER` | DB Username | Local Docker: `fortix` (free, chosen by you). Supabase Free Tier: `postgres.<project-ref>` (from Supabase **Connect -> Session Pooler**). |
| `POSTGRES_DB` | DB Name | Local Docker: `fortix_db` (free, chosen by you). Supabase Free Tier: `postgres`. |
| `POSTGRES_PASSWORD` | DB Password | Local Docker: generated free on your PC (`node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`). Supabase Free Tier: set/reset in **Supabase Dashboard -> Project Settings -> Database -> Database password**. |

---

## 2. One-Command Free Local Setup (Windows PowerShell, macOS & Linux Bash)

Because FortiX includes a cross-platform Node.js generator (`scripts/setup-local.js`), the exact same command works in **Windows PowerShell**, **Command Prompt**, **macOS Terminal**, and **Linux Bash**:

### Option A: Standalone Local Development (No Docker or Cloud Needed)
```bash
npm run setup:local
npm run dev
```

### Option B: Reproducible Local Docker Staging (`postgres` + `redis` + `api` + `worker`)
Works in both **Bash** and **Windows PowerShell**:
```bash
npm run setup:local -- --staging --force
docker compose up --build -d
```

### Manual Secret Generation Commands (If Needed)
- **Windows PowerShell (using Node.js — built in)**:
  ```powershell
  node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
  node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
  node -e "console.log('POSTGRES_PASSWORD=' + require('crypto').randomBytes(16).toString('hex'))"
  ```
- **Linux / macOS / Git Bash**:
  ```bash
  openssl rand -hex 32   # Use for JWT_SECRET
  openssl rand -hex 32   # Use for ENCRYPTION_KEY
  openssl rand -hex 16   # Use for POSTGRES_PASSWORD
  ```

---

## 3. Mandatory Credential Rotation Protocol (Exposed Credentials)

If any credential is ever pasted into chat, screenshots, logs, or commits, treat it as compromised and rotate immediately:

1. **Supabase PostgreSQL Password**:
   - Open **Supabase Dashboard -> Project Settings -> Database -> Reset database password**.
   - Generate a strong password and update `DATABASE_URL` in your local `.env` only (percent-encode special characters such as `@` $\rightarrow$ `%40`).
2. **Upstash Redis Credential**:
   - Open **Upstash Console -> Database Details -> Reset Password** (or delete and recreate the free Redis database).
   - Update `REDIS_URL` (`rediss://default:<new-token>@<endpoint>.upstash.io:6379`) in your local `.env` only.
3. **External Database / Platform API Keys (e.g., Neon / Management API keys)**:
   - Revoke the exposed API key in the provider's account settings -> **API Keys**.
4. **Verification**:
   - Confirm old credentials fail authentication (`ECONNREFUSED` / `WRONGPASS` / `28P01 password authentication failed`).
   - Run `npm run db:migrate` and verify `GET /health/ready` returns `200 OK` with your local `.env`.
