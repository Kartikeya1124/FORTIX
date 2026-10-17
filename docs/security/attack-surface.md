# FortiX Attack Surface Analysis & Inventory

## 1. System Overview & Entry Points

FortiX exposes two primary architectural planes:
1. **Control Plane (`/api/control/*`, `/api/auth/*`)**:
   - Administrative and operational plane consumed by web dashboard operators, automation agents, and external CI/CD pipelines.
   - Entry points: User authentication (JWT + HTTP-only cookies), Project CRUD, API Key management, Autonomous Workflow Runs (`/api/control/runs`), Chaos Experimentation, and System Health Telemetry.
2. **Data & Gateway Plane (`/proxy/:routeId`)**:
   - High-throughput reverse proxy routing traffic from external consumers to upstream target microservices.
   - Enforces FortiX API Key verification (`fx_live_*` / `fx_test_*`), SSRF validation, regex threat signature scanning (SQLi, XSS, Path Traversal), token-bucket rate limiting via Redis Lua, and real telemetry provenance.
3. **Real-time Event Stream (`/socket.io`)**:
   - WebSocket interface broadcasting tenant-isolated runtime telemetry, threat detection alerts, and autonomous workflow timeline state changes.

---

## 2. Comprehensive Endpoint Attack Surface Inventory

| Interface / Endpoint | Protocol / Auth | Trust Boundary | Primary Threats | Mitigations Implemented |
|---|---|---|---|---|
| `POST /api/auth/register`, `/login` | HTTPS / Public | Public Internet → Control Plane | Brute force, credential stuffing, SQLi | Bcrypt hashing (cost 10), strict Zod input validation, sanitized parameters |
| `GET/POST /proxy/:routeId` | HTTPS / FortiX API Key | Public Consumer → Protected Upstream | SSRF, API Key brute force, WAF bypass, DoS | `isSafeTarget()` DNS/IP validation, atomic Lua token bucket, bcrypt key check with 30s cache |
| `POST /api/control/runs` | HTTPS / Bearer JWT | Authenticated Operator → Autonomous Engine | Excessive concurrency, blast radius breakout, unauthorized target probing | Project ownership check, route isolation, 5-min execution cap, 100-request burst ceiling |
| `POST /api/control/keys/:id/rotate` | HTTPS / Bearer JWT | Authenticated Operator → Key Vault | Key leakage, unauthorized rotation | Project tenant check, immediate distributed Redis cache invalidation, audit logging |
| `GET /api/control/reports/:id` | HTTPS / Bearer JWT | Authenticated Operator → Artifact Store | IDOR / BOLA, path traversal | Project UUID ownership validation, SHA256 integrity hash verification |
| `WS /socket.io` | WebSocket / Auth Handshake | Browser Client → Event Bus | Cross-tenant telemetry eavesdropping | Project room isolation (`broadcast(projectId, ...)`), sanitized event payloads |

---

## 3. Trust Boundaries & Data Flow Constraints

```
[ External Consumer / Prober ]
               │  (x-api-key: fx_live_...)
               ▼
┌────────────────────────────────────────────────────────┐
│ FortiX Gateway Plane (/proxy/:routeId)                 │
│ 1. Route Resolution (Project isolated)                 │
│ 2. SSRF Guard (isSafeTarget: denies 169.254, loopback) │
│ 3. WAF Engine (SQLi, XSS, Path Traversal regex)        │
│ 4. Rate Limiter (Redis Lua token bucket, fail-closed)  │
└──────────────────────────┬─────────────────────────────┘
                           │ Authenticated & Filtered Traffic
                           ▼
              [ Upstream Target Service ]
```

---

## 4. Blast Radius Containment & Safe Target Execution

Autonomous security and resilience runs are subject to hard operational limits:
- **Blast Radius Ceiling**: Max 100 requests per burst, max 30s execution timeout per step, max 5-min total run duration.
- **SSRF Defenses**: Validates target schemes (`http`, `https`), forbids cloud metadata IP (`169.254.169.254`), forbids private LAN IPv4/IPv6 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8` in production).
- **Ephemeral Key Lifecycle**: Run-scoped execution credentials (`fx_test_run_*`) are automatically revoked and deleted in the engine's `finally` block upon completion, cancellation, or crash.
- **Fault Injection Rollback**: Active route fault injection rules are guaranteed to be cleared from database and gateway in-memory caches upon run termination.
