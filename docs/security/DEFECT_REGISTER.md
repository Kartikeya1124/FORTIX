# FortiX Structured Security & Reliability Defect Register

- **Audit Baseline Commit (`origin/main`)**: `e7d1402dbe86197ade81396404c034b53850fae6`
- **Audit Scope**: Authentication, Session & Token Lifecycle, Multi-Tenant Authorization (BOLA/IDOR), API-Key Caching & Distributed Revocation, Outbound SSRF & DNS-Rebinding Guardrails, Webhook Delivery & Signature Replay Defense, Dead-Letter Queue (DLQ) Isolation, WAF Threat Detection, Artifact Storage Durability, Background Worker Lifecycle, and Structured Log Secret Redaction.

---

## FX-SEC-001 — Cross-Tenant BOLA / IDOR via `X-FortiX-Project-Id` Header Precedence
- **Severity**: Critical
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/middleware/project.ts`, `src/api/projects.ts`, `src/api/settings.ts`
- **Reproduction Steps**:
  1. Authenticate as Tenant B (owning `projectB`).
  2. Issue `DELETE /api/control/projects/<projectA>` or `PUT /api/control/projects/<projectA>/policies` or `PATCH /api/control/settings/security?projectId=<projectA>` with header `X-FortiX-Project-Id: <projectB>`.
- **Root Cause**: `requireProjectOwnership` evaluated `req.headers['x-fortix-project-id']` first and skipped checking `req.params.projectId` and `req.query.projectId`, while downstream route handlers read `req.params.projectId` or `req.query.projectId` directly.
- **Security / Functional Impact**: Complete cross-tenant project takeover/destruction: any authenticated user could rename, disable WAF/SSRF policies on, modify settings of, or delete any other tenant's project.
- **Fix Applied**: Rewrote `requireProjectOwnership` to validate every supplied project identifier (`params`, `body`, `query`, and `x-fortix-project-id` header) against the caller's organization, reject conflicting explicit IDs (`400`) and unowned IDs (`403`), normalize all request locations to the verified `projectId`, and add defense-in-depth `orgId` WHERE clauses + FK cascades + API-key cache eviction on project deletion in `src/api/projects.ts`.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-001`)
- **Validation Result**: Passed (`403` on all cross-tenant `PATCH`/`PUT`/`DELETE` vectors; target project verified untouched).
- **Remaining Risk**: Organization membership currently uses single-owner (`organizations.ownerId`) model; multi-member RBAC tables will require equivalent org-membership joins if introduced later.

---

## FX-SEC-002 — SSRF Allowlist Port/Subdomain Abuse, Trailing-Dot/IPv6 Bypasses, & 0-TTL DNS Rebinding
- **Severity**: Critical
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/gateway/ssrf.ts`, `src/services/SecurityGuard.ts`, `src/gateway/index.ts`
- **Reproduction Steps**:
  1. Supply `http://fortix-demo-api:6379/` (rewritten by gateway router to `http://127.0.0.1:6379/`), `http://fortix-demo-api.evil.com/`, `http://localhost./`, `http://metadata.google.internal./`, `http://user:pass@host/`, `http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/`, or `http://[64:ff9b::7f00:1]/`.
  2. Register a domain that passes initial DNS check and flips A/AAAA to `127.0.0.1` on upstream proxy socket connect.
- **Root Cause**: `startsWith('fortix-demo-api')` prefix matching + unrestricted port forwarding to `127.0.0.1:${port}`, unstripped trailing DNS root dots, uncanonicalized expanded IPv6/NAT64/Teredo/zone-ID forms, and lack of a connection-time `dns.lookup` verifier in the proxy HTTP/HTTPS agents.
- **Security / Functional Impact**: Arbitrary loopback port scanning (`127.0.0.1:*`), cloud metadata/internal host access via trailing dot or IPv6 translation prefixes, and 0-TTL DNS rebinding bypass during proxy forwarding.
- **Fix Applied**: Restricted demo allowlist via `isAllowedDemoApiUrl()` strictly to exact `fortix-demo-api` / `fortix-demo-api.internal` on port `3001`/default (disabled in production unless `START_DEMO_API=true`), stripped trailing dots, rejected URL credentials, canonicalized expanded IPv6 via `URL` + blocked `%` zone IDs / NAT64 (`64:ff9b::`) / Teredo (`2001:0::`), and wired `safeHttpAgent` / `safeHttpsAgent` (`safeDnsLookup`) into `src/gateway/index.ts`.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-002`), `tests/unit/ssrf.test.ts`, `tests/unit/security-guard.test.ts`
- **Validation Result**: Passed (`ESSRFBLOCKED` -> `403` on rebinding; all 11 bypass payloads blocked).
- **Remaining Risk**: Custom TLS SNI / HTTP/2 proxy tunneling is not enabled; standard HTTP/1.1 keep-alive sockets validate IPs at TCP connection establishment.

---

## FX-SEC-003 — Webhook Plaintext Secret Disclosure, 302 Redirect SSRF, Replay Timestamp Bypass, & Cross-Tenant DLQ Exposure
- **Severity**: High
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/api/webhooks.ts`, `src/lib/webhooks.ts`, `src/api/dlq.ts`, `src/lib/dlq.ts`
- **Reproduction Steps**:
  1. Query `GET /api/control/webhooks` or `GET /api/control/dlq` to read raw `secret` values; authenticate as Tenant B on `/api/control/dlq` to read/retry/purge Tenant A's failed jobs.
  2. Return HTTP `302 Location: http://169.254.169.254/latest/meta-data/` from an external webhook endpoint.
  3. Call `verifyWebhookSignature` with `v1=<hmac>` (no `t=`) or `t=0`.
- **Root Cause**: Unmasked `secret` columns in API/DLQ payloads, missing tenant ownership checks in `src/api/dlq.ts`, default `redirect: 'follow'` in `fetch()`, and optional timestamp parsing in `verifyWebhookSignature`.
- **Security / Functional Impact**: Cross-tenant leakage of webhook signing secrets and failed job payloads, cross-tenant DLQ sabotage, SSRF via HTTP 301/302/307 redirects, and eternal signature replay when `t=` is omitted.
- **Fix Applied**: Masked `secret` (`hasSecret: boolean`) in `src/api/webhooks.ts`, added creation-time SSRF validation (`allowDemoApi: false`), enforced `redirect: 'manual'` with per-hop `securityGuard.validateTarget` checks (max 3 hops), required positive numeric `t=` timestamps in `verifyWebhookSignature`, scrubbed sensitive keys in `recordDlqFailure`, and enforced caller project ownership across all `/api/control/dlq` endpoints.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-003`), `tests/unit/webhooks.test.ts`, `tests/unit/dlq.test.ts`
- **Validation Result**: Passed.
- **Remaining Risk**: Webhook secrets remain stored in `webhooks.secret` in PostgreSQL so outbound deliveries can compute HMAC signatures; database-level column encryption using `ENCRYPTION_KEY` is a recommended future enhancement.

---

## FX-SEC-004 — API-Key Rotation Race, Raw Key Heap Caching, Cached Expiry Bypass, Pre-Auth Fault Injection, & Per-Request Proxy Allocation
- **Severity**: High
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/api/keys.ts`, `src/gateway/index.ts`, `src/middleware/apiKeyAuth.ts`
- **Reproduction Steps**:
  1. Rotate a key under concurrent traffic (`invalidateApiKeyCache` ran before `bcrypt.hash` + `db.update`).
  2. Inspect `apiKeyCache` keys (raw `fx_...` keys and `secretHash` stored in heap) or use a cached key whose `expiresAt` elapsed within the 30s TTL.
  3. Send unauthenticated `/proxy/:routeId` requests during an active `timeout`/`error_5xx` experiment.
- **Root Cause**: Cache invalidation ordered before DB write on key rotation; plain `Map<string, CachedApiKey>` keyed by raw secret without `expiresAt` re-validation; fault injection executed before API-key verification; `createProxyMiddleware` instantiated on every request and forwarded `x-api-key` upstream.
- **Security / Functional Impact**: 30s stale-credential window after key rotation or expiration, unauthenticated fault amplification/metric pollution, upstream API-key leakage, and EventEmitter/socket memory pressure under sustained load.
- **Fix Applied**: Moved `invalidateApiKeyCache` + `publishKeyRevocation` after DB commit in `src/api/keys.ts`; replaced `apiKeyCache` with bounded SHA-256 `HashedApiKeyCache` stripping `secretHash`; enforced `expiresAt` on cache hits; moved route SSRF + API-key auth ahead of fault injection; pre-allocated shared proxy instances in `setupGateway`; stripped FortiX auth headers before upstream forwarding.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-004`), `tests/gate3.5-distributed-api-keys.test.ts`, `tests/gate4-gateway.test.ts`
- **Validation Result**: Passed.
- **Remaining Risk**: When running multiple replicas without a shared Redis instance (`isRealRedisActive === false`), cache invalidation is local to each replica up to the 30s TTL.

---

## FX-SEC-005 — WebSocket `'dev-secret'` Forgery, Missing Logout/Password-Change JWT Revocation, & Unbounded Bcrypt Input
- **Severity**: High
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/lib/jwt-security.ts`, `src/socket.ts`, `src/middleware/auth.ts`, `src/api/auth.ts`, `src/api/account.ts`
- **Reproduction Steps**:
  1. Connect to Socket.IO with a token signed using `'dev-secret'` when `JWT_SECRET` is unset, or connect with legitimate dev token (which failed due to secret mismatch with `auth.ts`).
  2. Call `POST /api/auth/logout` or `POST /api/control/account/password` and reuse the old Bearer JWT.
- **Root Cause**: `src/socket.ts` hardcoded `process.env.JWT_SECRET || 'dev-secret'` without `HS256` pinning or DB user lookup; `/logout` only cleared cookies without server-side token revocation; `/password` updated `passwordHash` without invalidating pre-existing JWTs; password schemas lacked `.max(128)`.
- **Security / Functional Impact**: WebSocket room spoofing in zero-config dev mode (and broken legitimate dev sockets), persistent post-logout/post-compromise session validity for 24h, and CPU threadpool DoS via multi-megabyte password inputs.
- **Fix Applied**: Centralized `HS256` verification, DB user lookup, SHA-256 token revocation (`fortix:revoked-jwt:*`), and password-version rotation (`fortix:pwd-ver:*`) in `src/lib/jwt-security.ts`; wired into HTTP `authenticate`, `/api/auth/me`, `/api/auth/logout`, `/api/control/account/password`, and Socket.IO handshake middleware; bounded password inputs to 128 chars and normalized emails.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-005`), `tests/gate2-auth-rbac.test.ts`
- **Validation Result**: Passed.
- **Remaining Risk**: Without persistent Redis, in-memory JWT revocation state resets on process restart (tokens remain bounded by `24h` `exp` and `pwdVer` check).

---

## FX-SEC-006 — Cross-Tenant Verification Report Tampering, Header Injection, & Ephemeral Local Artifact Registry
- **Severity**: High
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/api/reports.ts`, `src/storage/local-storage.ts`
- **Reproduction Steps**:
  1. Authenticate as Tenant B (`projectB`) and `POST /api/control/reports/<tenantA_verificationId>` with `{ projectId: projectB }` to overwrite Tenant A's `verifications.pdfS3Url`.
  2. Persist a report via `LocalStorageProvider`, restart the Node process (or instantiate a fresh `LocalStorageProvider`), and call `listByProject(projectId)` or `get(artifactId, projectId)` -> returns empty/`null`.
- **Root Cause**: `src/api/reports.ts` updated `verifications` by `verificationId` without verifying `verificationId -> experiments -> apiRoutes.projectId === projectId`; `LocalStorageProvider` stored metadata exclusively in an in-memory `Map`.
- **Security / Functional Impact**: Cross-tenant tampering of compliance verification evidence links, potential `Content-Disposition` header injection via unsanitized IDs, and loss of locally stored evidence artifacts across restarts.
- **Fix Applied**: Verified `verificationId` ownership via `experiments`/`apiRoutes` join before updating `verifications.pdfS3Url` (`403` on cross-project mismatch), sanitized `Content-Disposition` filenames, and persisted `.meta.json` sidecar files with automatic disk hydration in `LocalStorageProvider`.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-006`), `tests/unit/reports.test.ts`, `tests/unit/artifact-storage.test.ts`
- **Validation Result**: Passed.
- **Remaining Risk**: Container ephemeral filesystems still require S3/object-storage configuration (`STORAGE_PROVIDER=s3`) for multi-replica stateless deployments.

---

## FX-SEC-007 — WAF `URIError` 500 DoS, SQLi Tautology Bypass, Unredacted Credential Logging, & Metrics Cardinality
- **Severity**: Medium
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/threat-detection/index.ts`, `src/lib/logger.ts`, `src/api/index.ts`, `src/api/system.ts`
- **Reproduction Steps**:
  1. Request `/proxy/:routeId/?q=%` -> `decodeURIComponent` throws uncaught `URIError` (`500`).
  2. Request `/proxy/:routeId/?query=admin%27%20OR%201=1--` -> bypassed naive substring WAF.
  3. Trigger `pino-http` request logging with `Authorization` / `X-API-Key` headers -> printed raw credentials to stdout.
- **Root Cause**: Unhandled `decodeURIComponent`, URL-only substring patterns, missing Pino `redact` config, raw `req.path` on 404 Prometheus metrics, and unsanitized `dbError` strings.
- **Security / Functional Impact**: Trivial 500 error DoS, WAF evasion on common SQLi/XSS vectors, credential leakage into log aggregators, and Prometheus label cardinality exhaustion under 404 scanning.
- **Fix Applied**: Added safe multi-pass URL decoding and URL/query/body/header inspection in `src/threat-detection/index.ts`; configured `REDACTED_LOG_PATHS` in `src/lib/logger.ts`; normalized unmatched/proxy route labels and enforced `503` readiness when PostgreSQL fails in `src/api/index.ts`; stripped connection URIs from `dbError` in `src/api/system.ts`.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-007`)
- **Validation Result**: Passed.
- **Remaining Risk**: Signature-based regex WAF inspects up to depth 4 / 50 fields to prevent ReDoS; binary/multipart payloads are out of scope for JSON inspection.

---

## FX-REL-008 — Mock-Redis Queue Stall, Container Port `8080` Loopback Collision, & Worker Cache/Error Cleanup
- **Severity**: Medium
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/lib/port.ts`, `src/experiments/queue.ts`, `src/experiments/worker.ts`, `src/autonomous/engine.ts`, `src/lib/webhooks.ts`
- **Reproduction Steps**:
  1. Enqueue an experiment or webhook event when `isRealRedisActive === false` (`ioredis-mock`): `queue.add()` succeeds without throwing, but no BullMQ worker runs against mock Redis, leaving jobs stuck in `QUEUED`.
  2. Run experiments/autonomous probes in container environments where `PORT=8080` points to an external reverse proxy while Express listens on `3000`.
- **Root Cause**: Fallback runner only triggered when `queue.add()` threw; workers used `process.env.PORT || 3000`; `src/experiments/worker.ts` did not evict deleted `tempKey` from `apiKeyCache`, did not invalidate `expCache`, and swallowed exceptions instead of propagating to retry/DLQ.
- **Security / Functional Impact**: Stuck `QUEUED` experiments/webhooks in standalone mode, misrouted loopback probes in container environments, lingering temporary keys in gateway cache for up to 30s, and unrecorded worker failures.
- **Fix Applied**: Routed `!isRealRedisActive` directly to bounded retry + DLQ runners in `src/experiments/queue.ts` and `src/lib/webhooks.ts`; extracted side-effect-free `resolveGatewayPort()` in `src/lib/port.ts`; added `invalidateApiKeyCache`, `invalidateExpCache`, `traffic_burst` handling, missing-record guards, and error propagation in `src/experiments/worker.ts`.
- **Regression Test**: `tests/unit/autonomous-workflow.test.ts`, `tests/unit/worker-stress.test.ts`, `tests/unit/dlq.test.ts`
- **Validation Result**: Passed.
- **Remaining Risk**: Local fallback runners execute in-process via bounded timers and do not persist queued state across hard `SIGKILL` crashes (Real Redis + BullMQ required for cross-crash queue durability).

---

## FX-DEP-001 — Cloud Run Deployment Rollout Crash (`JWT_SECRET` / `DATABASE_URL` Hard Exit, Non-Root `EACCES`, & Standalone Rate-Limiter Block)
- **Severity**: Critical (Availability / Deployment Blocker)
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `server.ts`, `src/lib/jwt-security.ts`, `src/db/index.ts`, `src/db/init.ts`, `src/db/migrate.ts`, `src/lib/port.ts`, `src/storage/local-storage.ts`, `src/rate-limit/redis.ts`, `Dockerfile`
- **Reproduction Steps**:
  1. Build production bundle (`npm run build`) and launch in a clean Cloud Run environment (`env -i NODE_ENV=production K_SERVICE=fortix-prod PORT=8080 node dist/server.cjs`) without pre-populated `JWT_SECRET` or `DATABASE_URL`.
  2. Observe immediate `process.exit(1)` (`[SECURITY FATAL] Production startup rejected: JWT_SECRET is missing or empty`) before binding `$PORT`, followed by `[FATAL SECURITY SAFEGUARD]` throw on missing `DATABASE_URL`, causing Cloud Run revision rollout health checks to fail.
- **Root Cause**: Top-level `process.exit(1)` when `JWT_SECRET` was unset in `NODE_ENV=production`; unconditional throw in `initializeDatabase()` / `initDatabase()` / `runMigrations()` when `DATABASE_URL` was absent even when `STRICT_PERSISTENT_DB` was not enabled; `Dockerfile` running as non-root `USER fortix` over root-owned `/app` with `EXPOSE 3000`; and `checkRateLimit()` executing Redis Lua `eval` against `ioredis-mock` in standalone mode and failing closed (`429`).
- **Security / Functional Impact**: Complete Cloud Run deployment rollout failure when secrets are not externally injected, `EACCES` on local artifact writes in read-only/non-root containers, and `429` gateway blocking in standalone deployments without external Redis.
- **Fix Applied**:
  1. Generated a cryptographically strong 256-bit (`crypto.randomBytes(32).toString('hex')`) runtime `JWT_SECRET` when unconfigured in production unless `STRICT_PRODUCTION_SECRETS=true` (preserving `validateProductionJwtSecret` entropy checks).
  2. Enforced hard database startup failure strictly when `STRICT_PERSISTENT_DB=true`, allowing standalone Cloud Run deployments without `DATABASE_URL` to boot cleanly on isolated `pg-mem` with in-memory Drizzle migration tracking.
  3. Honored `PORT` whenever `K_SERVICE` or `NODE_ENV=production` is set (`src/lib/port.ts`), registered immediate pre-bootstrap liveness probes (`/health/live`, `/api/health/live`, `/_ah/health`), pre-created `fortix:fortix`-owned `/app/storage/artifacts` and `/app/reports` in `Dockerfile` (`PORT=8080`), added `os.tmpdir()` fallback in `LocalStorageProvider`, and routed standalone `!isRealRedisActive` rate limiting through the bounded local token bucket.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-008`), `tests/unit/production-hardening.test.ts`, live `dist/server.cjs` Cloud Run cold-boot smoke test (`PORT=8099`, `K_SERVICE=fortix-prod`)
- **Validation Result**: Passed (`/health/live`, `/health/ready`, `/health`, `/`, `/api/auth/register`, and `/api/auth/login` verified `200`/`201` on clean production bundle).
- **Remaining Risk**: Standalone Cloud Run instances without `DATABASE_URL` / `JWT_SECRET` use per-instance ephemeral storage and signing keys; set `DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET` (plus `STRICT_PERSISTENT_DB=true` and `STRICT_PRODUCTION_SECRETS=true`) for multi-instance stateful production persistence.

---

## FX-SEC-009 — Privilege Escalation on Registration (`role: 'ADMIN'`) & Missing Admin RBAC Boundary
- **Severity**: Critical
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/api/auth.ts`, `src/middleware/auth.ts`, `src/middleware/entitlements.ts`, `src/api/admin.ts`, `src/api/account.ts`, `src/components/AlertingSettings.tsx`
- **Reproduction Steps**:
  1. Send `POST /api/auth/register` with `{ email, password }` (or inject `{ role: 'ADMIN' }`).
  2. Observe `user.role === 'ADMIN'` assigned to every newly registered account.
- **Root Cause**: `src/api/auth.ts` hardcoded `role: 'ADMIN'` during user insertion to work around a placeholder check in `src/middleware/entitlements.ts`, granting administrative status to every registrant.
- **Security / Functional Impact**: Vertical privilege escalation on self-service registration; inability to separate ordinary tenant workspace operators (`DEVELOPER`) from platform administrators (`ADMIN`).
- **Fix Applied**: Changed `POST /api/auth/register` to strictly assign `role: 'DEVELOPER'` and `emailVerified: false` (ignoring any client-supplied `role`); added `requireAdmin` middleware and `/api/control/admin/users` audited role-management endpoints with self-demotion protection; scoped workspace entitlements (`DEVELOPER` + `ADMIN`) strictly within caller-owned projects while restricting `VIEWER` accounts.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-009`)
- **Validation Result**: Passed (`201` assigns `DEVELOPER`; `/api/control/admin/*` returns `403` for `DEVELOPER` and `200` for `ADMIN`).
- **Remaining Risk**: Administrative role promotion requires an existing `ADMIN` account or database bootstrap administrator.

---

## FX-SEC-010 — `localStorage` Session Token Exposure, Permissive Credentialed CORS (`origin: true`), & Missing Cookie CSRF Defense
- **Severity**: Critical
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/lib/cors-csrf.ts`, `server.ts`, `src/api/index.ts`, `src/api/auth.ts`, `src/lib/jwt-security.ts`, `src/socket.ts`, `src/lib/api.ts`, `src/components/Login.tsx`, `src/context/SocketContext.tsx`, `src/App.tsx`
- **Reproduction Steps**:
  1. Sign in via `Login.tsx` and inspect `window.localStorage.getItem('fortix_token')` (raw bearer JWT readable by any XSS vector).
  2. Send a cross-origin request with `Origin: https://evil.example.com` to `server.ts` -> reflected `Access-Control-Allow-Origin: https://evil.example.com` with `Access-Control-Allow-Credentials: true`.
- **Root Cause**: Frontend persisted JWTs in `localStorage`; `server.ts` used `cors({ origin: true, credentials: true })` and `src/socket.ts` used `cors: { origin: '*' }`; cookie-authenticated state-changing endpoints lacked CSRF validation.
- **Security / Functional Impact**: Complete session theft under any DOM XSS primitive, cross-origin credentialed API exposure, and cross-site request forgery risk on cookie sessions.
- **Fix Applied**: Issued `HttpOnly` session cookies (`fortix_session`, `Secure` over HTTPS) paired with Double-Submit CSRF tokens (`fortix_csrf` cookie + timing-safe `X-CSRF-Token` validation) and strict `ALLOWED_ORIGINS` + same-host CORS validation on both Express and Socket.IO; removed all `localStorage` `fortix_token` reads/writes across the frontend; wired `disconnectSocketsForToken` / `disconnectSocketsForUser` into logout, password rotation, and account deletion.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-010`)
- **Validation Result**: Passed (0 `localStorage` token references; `HttpOnly` cookie session works; missing CSRF header and untrusted `Origin` both rejected `403`; post-logout cookie replay rejected `401`).
- **Remaining Risk**: Programmatic API/CLI integrations using explicit `Authorization: Bearer` headers remain supported and must store tokens securely outside browser storage.

---

## FX-SEC-011 — Client-Only Password Reset Stub & Unverified Operator Emails
- **Severity**: High
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `drizzle/0004_auth_security_tokens.sql`, `src/db/schema.ts`, `src/lib/auth-tokens.ts`, `src/api/auth.ts`, `src/components/Login.tsx`, `src/pages/Settings.tsx`
- **Reproduction Steps**:
  1. Submit the Forgot Password form in `Login.tsx` -> only set a local React string without any backend request, token generation, or password update.
- **Root Cause**: Password recovery and email verification backend endpoints and hashed token persistence were never implemented.
- **Security / Functional Impact**: Operators could not recover locked accounts or verify email ownership; UI implied recovery instructions were queued when nothing occurred.
- **Fix Applied**: Added `users.email_verified` and `auth_action_tokens` migration (`0004_auth_security_tokens.sql`); implemented `issueAuthActionToken` and `consumeAuthActionToken` using 256-bit `crypto.randomBytes(32)` tokens stored exclusively as SHA-256 hashes with 15-minute (`PASSWORD_RESET`) / 24-hour (`EMAIL_VERIFICATION`) expiry and single-use `used_at` enforcement; implemented non-enumerating `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` (rotating password version and disconnecting active sockets), `POST /api/auth/verify-email`, and `POST /api/auth/resend-verification`; wired real 2-step UI flows in `Login.tsx` and `Settings.tsx`.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-011`)
- **Validation Result**: Passed (identical response on unknown vs known email, raw token absent from DB, expired and replayed tokens rejected `400`, password rotation and email verification verified end-to-end).
- **Remaining Risk**: Production email delivery requires configuring `AUTH_MAIL_WEBHOOK_URL` (local non-production environments provide an isolated dev outbox preview).

---

## FX-SEC-012 — Production Demo-Credential Exposure, Hardcoded Migration Fallbacks, Blanket `ECONNREFUSED` Suppression, & Account Lifecycle Completeness
- **Severity**: High
- **Status**: `FIXED AND VERIFIED`
- **Affected Component**: `src/components/Login.tsx`, `src/api/auth.ts`, `src/api/account.ts`, `src/db/migrate.ts`, `drizzle/postgres_rls_policies.sql`, `server.ts`, `src/redis.ts`, `src/api/index.ts`, `src/pages/NotFound.tsx`, `src/pages/LegalPages.tsx`, `src/pages/Settings.tsx`
- **Reproduction Steps**:
  1. Open `Login.tsx` -> `admin@fortix.test` / `password123` prefilled in state.
  2. Inspect `src/db/migrate.ts` (hardcoded `fortix_password` fallback URL and `render.com` synthetic throw) and `server.ts` (blanket `ECONNREFUSED` return in `uncaughtException`).
  3. Request `/api/unknown-route` -> fell through to HTML SPA instead of JSON `404`; no self-service account deletion or Privacy/Terms pages existed.
- **Root Cause**: Sandbox conveniences left enabled in production code paths; missing account deletion endpoint, `/api` 404 catch-all, RLS policy script, and legal disclosures.
- **Security / Functional Impact**: Risk of demo credential reuse in production, obscured dependency outages, misleading HTML 200 responses on mistyped API paths, and incomplete account deletion lifecycle.
- **Fix Applied**: Removed prefilled login credentials, gated sandbox helper out of production builds, and blocked demo accounts on `POST /api/auth/login` when `NODE_ENV=production`; removed hardcoded credentials and synthetic throws in `src/db/migrate.ts` and added `drizzle/postgres_rls_policies.sql`; enforced `503` on `/health/ready` if `STRICT_PERSISTENT_DB=true` is not backed by persistent Postgres; removed silent `ECONNREFUSED` swallowing in `server.ts` and exposed sanitized Redis outage diagnostics in `/api/health`; implemented re-authorized `DELETE /api/control/account` with immediate session/socket/API-key revocation; added `/api` JSON 404 handler, `<NotFound />` page, and `/privacy` & `/terms` pages.
- **Regression Test**: `tests/unit/security-redteam-regressions.test.ts` (`FX-SEC-012`), `tests/unit/migrations.test.ts`
- **Validation Result**: Passed.
- **Remaining Risk**: PostgreSQL RLS policies enforce `app.current_user_id` when connected via a non-superuser role (`NOBYPASSRLS`) with per-transaction `SET LOCAL app.current_user_id`; application-layer `requireProjectOwnership` remains mandatory primary enforcement.
