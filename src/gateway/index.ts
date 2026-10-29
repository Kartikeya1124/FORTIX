import { logger } from '../lib/logger.js';
import { Express, Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import http from 'http';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { apiRoutes, apiKeys, experiments, securityPolicies } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { isSafeTarget, isAllowedDemoApiUrl, safeHttpAgent, safeHttpsAgent } from './ssrf.js';
import { v4 as uuidv4 } from 'uuid';
import { enqueueMetric, enqueueSecurityEvent } from '../lib/telemetry.js';
import { checkRateLimit } from '../rate-limit/redis.js';
import { detectThreats } from '../threat-detection/index.js';
import { broadcast } from '../socket.js';
import bcrypt from 'bcryptjs';

// Cache for verified API keys to prevent CPU threadpool starvation under proxy load.
// Stores ONLY SHA-256 digests of raw keys and strips secretHash from cached metadata.
export interface CachedApiKey {
  key: any;
  cachedAt: number;
}

const MAX_KEY_CACHE_SIZE = 5000;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function normalizeCacheKey(rawOrDigest: string): string {
  if (SHA256_HEX_RE.test(rawOrDigest) && !rawOrDigest.startsWith('fx_')) {
    return rawOrDigest.toLowerCase();
  }
  return crypto.createHash('sha256').update(String(rawOrDigest)).digest('hex');
}

class HashedApiKeyCache extends Map<string, CachedApiKey> {
  override get(rawOrDigest: string): CachedApiKey | undefined {
    return super.get(normalizeCacheKey(rawOrDigest));
  }

  override has(rawOrDigest: string): boolean {
    return super.has(normalizeCacheKey(rawOrDigest));
  }

  override set(rawOrDigest: string, value: CachedApiKey): this {
    const digest = normalizeCacheKey(rawOrDigest);
    if (!super.has(digest) && this.size >= MAX_KEY_CACHE_SIZE) {
      const oldestKey = super.keys().next().value;
      if (oldestKey !== undefined) {
        super.delete(oldestKey);
      }
    }
    const { secretHash: _omitSecretHash, ...safeKey } = value?.key || {};
    return super.set(digest, {
      key: safeKey,
      cachedAt: value.cachedAt,
    });
  }

  override delete(rawOrDigest: string): boolean {
    return super.delete(normalizeCacheKey(rawOrDigest));
  }
}

export const apiKeyCache: Map<string, CachedApiKey> = new HashedApiKeyCache();

export function getApiKeyCacheSize(): number {
  return apiKeyCache.size;
}

export function invalidateApiKeyCache(keyId?: string, projectId?: string) {
  if (!keyId && !projectId) {
    apiKeyCache.clear();
    return;
  }
  for (const [digest, entry] of apiKeyCache.entries()) {
    if (keyId) {
      if (entry.key?.id === keyId) {
        apiKeyCache.delete(digest);
      }
    } else if (projectId) {
      if (entry.key?.projectId === projectId) {
        apiKeyCache.delete(digest);
      }
    }
  }
}

// 2-second cache for active experiments per route
const expCache = new Map<string, { exps: any[]; cachedAt: number }>();

export function invalidateExpCache(routeId?: string) {
  if (!routeId) {
    expCache.clear();
    return;
  }
  expCache.delete(routeId);
}

interface ProxyRequestContext {
  route: typeof apiRoutes.$inferSelect;
  routeId: string;
  requestId: string;
  startHrTime: bigint;
  upstreamTimeoutMs: number;
  resolvedTargetUrl: string;
}

const demoLoopbackAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });

function extractGatewayApiKey(req: Request): string | null {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer fx_')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function createSharedGatewayProxy(agent: http.Agent) {
  return createProxyMiddleware({
    target: 'http://127.0.0.1:3001',
    agent,
    changeOrigin: true,
    xfwd: true,
    router: (req) => {
      const ctx: ProxyRequestContext | undefined = (req as any).__fortixProxyCtx;
      return ctx?.resolvedTargetUrl || 'http://127.0.0.1:3001';
    },
    pathRewrite: (pathStr, req) => {
      const ctx: ProxyRequestContext | undefined = (req as any).__fortixProxyCtx;
      if (!ctx?.routeId) return pathStr;
      const escapedRouteId = ctx.routeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return pathStr.replace(new RegExp(`^/proxy/${escapedRouteId}`), '');
    },
    on: {
      proxyReq: (proxyReq, req, res) => {
        const ctx: ProxyRequestContext | undefined = (req as any).__fortixProxyCtx;

        // Strip FortiX gateway credentials before forwarding to external upstreams
        proxyReq.removeHeader('x-api-key');
        proxyReq.removeHeader('x-fortix-token');
        const authVal = proxyReq.getHeader('authorization');
        if (typeof authVal === 'string' && authVal.startsWith('Bearer fx_')) {
          proxyReq.removeHeader('authorization');
        }

        const timeoutMs = ctx?.upstreamTimeoutMs || 5000;
        proxyReq.setTimeout(timeoutMs, () => {
          proxyReq.destroy(Object.assign(new Error(`Upstream target timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
        });

        let isResponseCompleted = false;

        const onFinish = () => {
          isResponseCompleted = true;
          cleanup();
        };

        const onClientAbort = () => {
          if (!isResponseCompleted && !res.writableEnded && !res.writableFinished) {
            logger.warn(
              { routeId: ctx?.routeId, requestId: ctx?.requestId },
              '[Gateway] Client connection terminated prematurely. Aborting upstream request.'
            );
            try {
              proxyReq.destroy();
            } catch {}
          }
          cleanup();
        };

        const cleanup = () => {
          res.removeListener('finish', onFinish);
          res.removeListener('close', onClientAbort);
          req.removeListener('aborted', onClientAbort);
        };

        res.once('finish', onFinish);
        res.once('close', onClientAbort);
        req.once('aborted', onClientAbort);
      },
      proxyRes: async (proxyRes, req) => {
        const ctx: ProxyRequestContext | undefined = (req as any).__fortixProxyCtx;
        if (!ctx) return;

        const durationMs = Number(process.hrtime.bigint() - ctx.startHrTime) / 1000000;
        const statusCode = proxyRes.statusCode || 500;
        const logId = uuidv4();

        enqueueMetric({
          id: logId,
          routeId: ctx.routeId,
          requestId: ctx.requestId,
          experimentId: (req.headers['x-experiment-id'] as string) || (req.headers['x-fortix-run-id'] as string) || null,
          latencyMs: Math.round(durationMs),
          statusCode,
        });
        Promise.resolve()
          .then(() => {
            broadcast(ctx.route.projectId, 'metric:new', {
              id: logId,
              routeId: ctx.routeId,
              latencyMs: Math.round(durationMs),
              statusCode,
            });
          })
          .catch((e) => logger.error({ err: e }, '[Gateway] Broadcast metric error'));
      },
      error: async (err: any, req, res) => {
        const ctx: ProxyRequestContext | undefined = (req as any).__fortixProxyCtx;
        const responseObj = res as Response;
        if (!ctx) {
          if (typeof responseObj.status === 'function' && !responseObj.headersSent) {
            responseObj.status(502).json({ error: 'Bad Gateway: Upstream failure' });
          }
          return;
        }

        const durationMs = Number(process.hrtime.bigint() - ctx.startHrTime) / 1000000;
        const logId = uuidv4();

        // Connection-time DNS rebinding / SSRF socket block
        if (err?.code === 'ESSRFBLOCKED') {
          const eventId = uuidv4();
          enqueueSecurityEvent({
            id: eventId,
            routeId: ctx.routeId,
            type: 'SSRF_ATTEMPT',
            severity: 'HIGH',
            action: 'blocked',
            sourceIp: (req as Request).ip || 'unknown',
          });
          enqueueMetric({
            id: logId,
            routeId: ctx.routeId,
            requestId: ctx.requestId,
            experimentId: (req.headers['x-experiment-id'] as string) || (req.headers['x-fortix-run-id'] as string) || null,
            latencyMs: Math.round(durationMs),
            statusCode: 403,
          });
          broadcast(ctx.route.projectId, 'security:event', {
            id: eventId,
            routeId: ctx.routeId,
            type: 'SSRF_ATTEMPT',
            severity: 'HIGH',
          });
          if (typeof responseObj.status === 'function' && !responseObj.headersSent) {
            responseObj.status(403).json({ error: 'Forbidden: SSRF target blocked' });
          }
          return;
        }

        const isTimeout =
          err?.code === 'ETIMEDOUT' ||
          err?.code === 'ESOCKETTIMEDOUT' ||
          err?.code === 'ECONNABORTED' ||
          err?.code === 'ERR_GATEWAY_TIMEOUT' ||
          (err?.message &&
            (err.message.toLowerCase().includes('timeout') ||
              err.message.toLowerCase().includes('etimedout') ||
              err.message.toLowerCase().includes('esockettimedout')));

        const statusCode = isTimeout ? 504 : 502;
        const errorMessage = isTimeout
          ? `Gateway Timeout: Upstream target timed out after ${ctx.upstreamTimeoutMs}ms`
          : 'Bad Gateway: Upstream failure';

        enqueueMetric({
          id: logId,
          routeId: ctx.routeId,
          requestId: ctx.requestId,
          experimentId: (req.headers['x-experiment-id'] as string) || (req.headers['x-fortix-run-id'] as string) || null,
          latencyMs: Math.round(durationMs),
          statusCode,
        });
        Promise.resolve()
          .then(() => {
            broadcast(ctx.route.projectId, 'metric:new', {
              id: logId,
              routeId: ctx.routeId,
              latencyMs: Math.round(durationMs),
              statusCode,
            });
          })
          .catch((e) => logger.error({ err: e }, '[Gateway] Broadcast error metric error'));

        if (typeof responseObj.status === 'function' && !responseObj.headersSent) {
          responseObj.status(statusCode).json({ error: errorMessage });
        }
      },
    },
  });
}

export function setupGateway(app: Express) {
  // Ensure distributed API-key invalidation listener is active
  try {
    import('../lib/key-invalidation.js')
      .then(({ setupKeyRevocationSubscriber }) => {
        setupKeyRevocationSubscriber();
      })
      .catch(() => {});
  } catch {}

  // Pre-allocated shared proxy instances prevent per-request EventEmitter / agent leaks
  const demoProxy = createSharedGatewayProxy(demoLoopbackAgent);
  const externalHttpProxy = createSharedGatewayProxy(safeHttpAgent);
  const externalHttpsProxy = createSharedGatewayProxy(safeHttpsAgent as unknown as http.Agent);

  app.use('/proxy/:routeId', async (req: Request, res: Response, next: NextFunction) => {
    const routeId = req.params.routeId as string;
    const startHrTime = process.hrtime.bigint();
    const requestId = uuidv4();

    try {
      // 1. Resolve Route
      const [route] = await db.select().from(apiRoutes).where(eq(apiRoutes.id, routeId)).limit(1);
      if (!route) return res.status(404).json({ error: 'Route not found' });

      // 2. Static SSRF Protection Check (before authentication or fault execution)
      if (!isSafeTarget(route.targetUrl)) {
        return res.status(502).json({ error: 'Bad Gateway: Invalid target' });
      }

      // 3. API Key Auth (strictly enforced BEFORE fault injection so unauthenticated callers cannot trigger delays/metrics)
      const rawKey = extractGatewayApiKey(req);
      if (!rawKey) return res.status(401).json({ error: 'Missing API Key' });

      const parts = rawKey.split('_');
      // Expected: fx_{env}_{keyId}_{secret}
      if (parts.length !== 4 || parts[0] !== 'fx') {
        return res.status(401).json({ error: 'Malformed API Key' });
      }

      const keyId = parts[2];
      const secret = parts[3];

      let validKey: any = null;
      const nowMs = Date.now();

      // Check fast hashed cache first (enforcing projectId, revocation, AND expiration)
      const cached = apiKeyCache.get(rawKey);
      if (cached && nowMs - cached.cachedAt < 30000) {
        const notExpired = !cached.key?.expiresAt || new Date(cached.key.expiresAt).getTime() > nowMs;
        if (cached.key && cached.key.projectId === route.projectId && !cached.key.revokedAt && notExpired) {
          validKey = cached.key;
        } else {
          apiKeyCache.delete(rawKey);
        }
      }

      if (!validKey) {
        const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);

        if (k && k.projectId === route.projectId && !k.revokedAt) {
          if (!k.expiresAt || new Date(k.expiresAt).getTime() > nowMs) {
            const isValid = await bcrypt.compare(secret, k.secretHash);
            if (isValid) {
              validKey = k;
              apiKeyCache.set(rawKey, { key: k, cachedAt: nowMs });
            }
          }
        }
      }

      if (!validKey) {
        const eventId = uuidv4();
        enqueueSecurityEvent({
          id: eventId,
          routeId,
          type: 'INVALID_API_KEY',
          severity: 'MEDIUM',
          action: 'blocked',
          sourceIp: req.ip || 'unknown',
        });
        broadcast(route.projectId, 'security:event', {
          id: eventId,
          routeId,
          type: 'INVALID_API_KEY',
          severity: 'MEDIUM',
        });
        return res.status(401).json({ error: 'Invalid or Revoked API Key' });
      }

      const apiKeyId = validKey.id;

      // 4. Route-Level Security Policy Lookup (WAF & Deep Parameter SSRF Inspection)
      const [routePolicy] = await db.select().from(securityPolicies).where(eq(securityPolicies.routeId, routeId)).limit(1);

      if (routePolicy?.enableSsrf) {
        const ssrfParamKeys = ['url', 'target', 'redirect', 'callback', 'dest', 'uri', 'webhook', 'endpoint'];
        const candidateValues: string[] = [];
        for (const k of ssrfParamKeys) {
          const qVal = (req.query as Record<string, unknown>)?.[k];
          if (typeof qVal === 'string') candidateValues.push(qVal);
          const bVal = (req.body as Record<string, unknown>)?.[k];
          if (typeof bVal === 'string') candidateValues.push(bVal);
        }
        for (const candidate of candidateValues) {
          let decodedCandidate = candidate.trim();
          try {
            decodedCandidate = decodeURIComponent(decodedCandidate).trim();
          } catch {}
          if ((/^https?:\/\//i.test(candidate.trim()) && !isSafeTarget(candidate.trim())) ||
              (/^https?:\/\//i.test(decodedCandidate) && !isSafeTarget(decodedCandidate))) {
            const eventId = uuidv4();
            enqueueSecurityEvent({
              id: eventId,
              routeId,
              type: 'SSRF_ATTEMPT',
              severity: 'HIGH',
              action: 'blocked',
              sourceIp: req.ip || 'unknown',
            });
            broadcast(route.projectId, 'security:event', {
              id: eventId,
              routeId,
              type: 'SSRF_ATTEMPT',
              severity: 'HIGH',
            });
            return res.status(403).json({ error: 'Forbidden: SSRF target blocked' });
          }
        }
      }

      // 4.5 Threat Detection (WAF enforced by default; monitor-only if route policy explicitly sets enableWaf=false)
      const wafShouldBlock = routePolicy ? Boolean(routePolicy.enableWaf) : true;
      const threats = detectThreats(req);
      if (threats.length > 0) {
        for (const threat of threats) {
          const eventId = uuidv4();
          enqueueSecurityEvent({
            id: eventId,
            routeId,
            type: threat,
            severity: 'HIGH',
            action: wafShouldBlock ? 'blocked' : 'monitored',
            sourceIp: req.ip || 'unknown',
          });
          broadcast(route.projectId, 'security:event', {
            id: eventId,
            routeId,
            type: threat,
            severity: 'HIGH',
          });
        }
        if (wafShouldBlock) {
          return res.status(403).json({ error: 'Forbidden: Suspicious activity detected' });
        }
      }

      // 5. Rate Limiting
      const limitResult = await checkRateLimit(route.projectId, routeId, apiKeyId || req.ip || 'anonymous');
      if (limitResult) {
        res.setHeader('X-RateLimit-Limit', limitResult.limit);
        res.setHeader('X-RateLimit-Remaining', limitResult.remaining);
        if (!limitResult.allowed) {
          const eventId = uuidv4();
          enqueueSecurityEvent({
            id: eventId,
            routeId,
            type: 'RATE_LIMIT_EXCEEDED',
            severity: 'LOW',
            action: 'blocked',
            sourceIp: req.ip || 'unknown',
          });
          enqueueMetric({
            id: uuidv4(),
            routeId,
            experimentId: (req.headers['x-experiment-id'] as string) || null,
            latencyMs: Math.round(Number(process.hrtime.bigint() - startHrTime) / 1000000),
            statusCode: 429,
          });
          broadcast(route.projectId, 'security:event', {
            id: eventId,
            routeId,
            type: 'RATE_LIMIT_EXCEEDED',
            severity: 'LOW',
          });
          return res.status(429).json({ error: 'Too Many Requests' });
        }
      }

      // 5.5 Fault Injection (authenticated traffic only)
      let runningExps: any[] = [];
      const cachedExp = expCache.get(routeId);
      if (cachedExp && Date.now() - cachedExp.cachedAt < 2000) {
        runningExps = cachedExp.exps;
      } else {
        const activeExps = await db.select().from(experiments).where(eq(experiments.routeId, routeId));
        runningExps = activeExps.filter((e) => e.status === 'RUNNING' || e.status === 'QUEUED');
        expCache.set(routeId, { exps: runningExps, cachedAt: Date.now() });
      }

      let injectedLatency = 0;
      let injectedError = false;

      for (const exp of runningExps) {
        if (exp.type === 'latency') injectedLatency = Math.max(injectedLatency, (exp.config as any)?.latencyMs || 800);
        if (exp.type === 'error_5xx') injectedError = true;
        if (exp.type === 'timeout') injectedLatency = Math.max(injectedLatency, 6000);
      }

      if (injectedLatency > 0) {
        await new Promise((r) => setTimeout(r, injectedLatency));
      }

      if (injectedError) {
        const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1000000;
        const logId = uuidv4();
        enqueueMetric({
          id: logId,
          routeId,
          experimentId: (req.headers['x-experiment-id'] as string) || (req.headers['x-fortix-run-id'] as string) || null,
          latencyMs: Math.round(durationMs),
          statusCode: 503,
        });
        broadcast(route.projectId, 'metric:new', {
          id: logId,
          routeId,
          latencyMs: Math.round(durationMs),
          statusCode: 503,
        });
        return res.status(503).json({ error: 'Service Unavailable (Fault Injection)' });
      }

      // 6. Proxy with DNS-rebinding-protected agents and strict demo-API port confinement
      const upstreamTimeoutMs = parseInt(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || '5000', 10);
      const parsedTarget = new URL(route.targetUrl);
      const isDemoUpstream = isAllowedDemoApiUrl(parsedTarget);

      const cleanDemoHost = parsedTarget.hostname.toLowerCase().replace(/\.+$/, '');
      const isTestInternalHarness =
        cleanDemoHost === 'fortix-demo-api.internal' &&
        (process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST));
      const demoPort = isTestInternalHarness ? parsedTarget.port || '3001' : '3001';

      const resolvedTargetUrl = isDemoUpstream
        ? `${parsedTarget.protocol}//127.0.0.1:${demoPort}${parsedTarget.pathname}${parsedTarget.search}`
        : route.targetUrl;

      (req as any).__fortixProxyCtx = {
        route,
        routeId,
        requestId,
        startHrTime,
        upstreamTimeoutMs,
        resolvedTargetUrl,
      } satisfies ProxyRequestContext;

      if (isDemoUpstream) {
        return demoProxy(req, res, next);
      }
      if (parsedTarget.protocol === 'https:') {
        return externalHttpsProxy(req, res, next);
      }
      return externalHttpProxy(req, res, next);
    } catch (err) {
      next(err);
    }
  });
}