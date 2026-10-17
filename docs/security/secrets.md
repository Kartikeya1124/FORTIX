# FortiX Secrets Management & Credential Lifecycle Policy

## 1. Secrets Inventory & Classification

| Secret Name | Purpose | Storage Mechanism | Rotation Lifecycle | Scope & Entropy Requirements |
|---|---|---|---|---|
| `JWT_SECRET` | Signs Control Plane access & refresh tokens | Server environment variable (`.env`) | Rotated quarterly or on compromise | Min 32 characters, high entropy, rejected on default values |
| `FortiX API Keys` (`fx_*`) | Authenticates external clients to Gateway | Persistent PostgreSQL (bcrypt hashed secret only) | On-demand via `/api/control/keys/:id/rotate` | Format: `fx_<env>_<keyId>_<secret>`, 32-byte cryptographic random secret |
| `GEMINI_API_KEY` | Server-side AI evidence analysis | Server environment variable (`process.env.GEMINI_API_KEY`) | Managed via Google Cloud Console | Server-side only, never transmitted to browser or logged |
| `DATABASE_URL` | PostgreSQL connection credentials | Server environment variable (`.env`) | Managed by Cloud SQL / Infrastructure | Strictly enforced in production; in-memory fallback rejected |
| `REDIS_URL` | Redis distributed cache & BullMQ queue | Server environment variable (`.env`) | Managed by Infrastructure provider | Required for cross-process durable job execution |

---

## 2. FortiX-Issued API Key Security Architecture

1. **Cryptographic Generation**:
   - Format: `fx_${environment}_${keyId}_${secret}`
   - `keyId`: 8-byte cryptographically random hex (16 chars). Acts as a public database lookup index.
   - `secret`: 32-byte cryptographically random hex (64 chars, 256-bit entropy).
2. **One-Time Display**:
   - The raw composite key is returned to the caller **exactly once** in the HTTP 201 response body upon creation or rotation.
   - It is never stored in plaintext anywhere in the database, memory cache, or log stream.
3. **Storage Security**:
   - Only `secretHash` (bcrypt cost 10) is persisted in the `api_keys` table.
   - Even in the event of an SQL read injection or database snapshot leak, raw keys cannot be recovered.
4. **Fast In-Memory Cache Security**:
   - Verified keys are cached in memory for 30 seconds to prevent bcrypt CPU threadpool starvation under high proxy throughput.
   - Key revocation or rotation broadcasts a Redis Pub/Sub invalidation message across all gateway nodes (`publishKeyRevocation`), purging cached entries immediately.
5. **Quota Enforcement**:
   - Strictly limits each API project to a maximum of 25 active keys to prevent key sprawl and database bloat.

---

## 3. Secret Protection & Anti-Leakage Guardrails

- **Zero Secrets in Source Control**: All test tokens in test suites are generated dynamically at test runtime (`crypto.randomBytes(32)`).
- **Log Sanitization**: Pino HTTP and application loggers explicitly redact `authorization`, `cookie`, `x-api-key`, and `password`.
- **AI Evidence Redaction**: `sanitizeEvidenceForAi()` strips all authentication headers, URL query credentials, and internal hostnames before dispatching telemetry to `@google/genai`.
- **Graceful Unconfigured Handling**: If `GEMINI_API_KEY` is not present, FortiX continues normal execution and marks AI analysis as unavailable rather than leaking errors.
