# FortiX Production Security Verification Checklist

This checklist defines mandatory security controls and verification checks enforced across FortiX deployments.

## 1. Authentication & Tenant Isolation
- [x] **Strict Tenant Scoping**: Every control plane endpoint queries resources constrained by `WHERE project_id = :projectId AND org.owner_id = :userId`.
- [x] **IDOR / BOLA Prevention**: Direct object references (`routeId`, `verificationId`, `artifactId`, `keyId`) verify project ownership prior to processing.
- [x] **JWT Cryptographic Hardening**: Validates JWT secret entropy on startup; rejects default strings ('secret', 'password', '12345').
- [x] **Secure Cookies**: Refresh tokens are stored in `httpOnly`, `sameSite=strict` cookies.

## 2. Gateway & Proxy Protection
- [x] **SSRF Defense**: `isSafeTarget()` verifies every upstream URL against cloud metadata endpoints (`169.254.169.254`) and restricted private subnets.
- [x] **WAF Signature Detection**: Inspects query parameters, path segments, and request headers for SQL injection, Cross-Site Scripting (XSS), and Path Traversal.
- [x] **Fail-Closed Rate Limiting**: Defaults to fail-closed in production when Redis connectivity drops, preventing unconstrained DDoS bypasses.
- [x] **Upstream Timeout Bounding**: Enforces deterministic upstream socket timeouts (default 5000ms), cleanly mapping hang states to HTTP 504 Gateway Timeout.

## 3. API Key Lifecycle & Governance
- [x] **Opaque Cryptographic Keys**: Keys generated with 256-bit entropy (`fx_<env>_<keyId>_<secret>`).
- [x] **Bcrypt Hash Storage**: Only hashed secrets stored; raw secrets displayed only once.
- [x] **Instant Revocation**: Redis Pub/Sub invalidation flushes local in-process caches across all cluster nodes within milliseconds.
- [x] **Granular Scopes**: Enforces scope checks (`gateway:proxy`, `metrics:read`, `admin`).
- [x] **Rotation Endpoint**: Dedicated `POST /api/control/keys/:id/rotate` endpoint with audit log generation.

## 4. Autonomous Execution & Fault Recovery
- [x] **Bounded Blast Radius**: Probes capped at max 100 requests per burst, 5-minute maximum timeout.
- [x] **Guaranteed Fault Cleanup**: Fault injection rules and ephemeral test keys are deleted in `finally` blocks upon completion, cancellation, or crash.
- [x] **Idempotent Terminal States**: State transitions (`COMPLETED`, `FAILED`, `CANCELLED`) cannot be overwritten or re-executed.
- [x] **Deterministic Truth**: Scores and SLA compliance are calculated strictly from real PostgreSQL `metric_logs` and `security_events`.

## 5. AI Reasoning & Data Protection
- [x] **Evidence Sanitization**: `sanitizeEvidenceForAi()` redacts authentication tokens, credentials, and internal host details.
- [x] **Read-Only Advisory Role**: AI cannot change security policies, override pass/fail verdicts, or execute arbitrary operations.
- [x] **Graceful Absence**: System remains 100% operational when `GEMINI_API_KEY` is not configured.
- [x] **Schema Validation**: Output strictly validated against structured JSON schemas.
