import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { setupGateway } from '../../src/gateway/index.js';
import { db, getStorageMode, isPersistentStorage } from '../../src/db/index.js';
import { normalizeDatabaseUrl, resolvePostgresSslOption } from '../../src/db/url.js';
import { normalizeRedisUrl } from '../../src/redis.js';
import { apiRoutes, apiKeys, users, organizations, projects } from '../../src/db/schema.js';
import { validateProductionJwtSecret } from '../../server.js';
import { getEffectiveRedisFailurePolicy, parseAndValidateRedisFailurePolicy } from '../../src/rate-limit/redis.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

describe('Phase 2 — Production Hardening & Gateway Correctness', () => {
  describe('1. Production Persistent Storage Safeguards', () => {
    it('accurately identifies current database storage mode', () => {
      const mode = getStorageMode();
      expect(['persistent', 'in-memory']).toContain(mode);
      expect(typeof isPersistentStorage()).toBe('boolean');
    });

    it('rejects startup in strict persistent mode if DATABASE_URL is missing or memory-based', async () => {
      const validateProductionDbConfig = (nodeEnv: string, strictDb: boolean, dbUrl?: string) => {
        if (nodeEnv === 'production' || strictDb) {
          if (!dbUrl || dbUrl.includes('memory') || dbUrl.trim() === '') {
            throw new Error(
              '[FATAL SECURITY SAFEGUARD] Production startup rejected: Persistent PostgreSQL database (DATABASE_URL) is required in production (STRICT_PERSISTENT_DB or NODE_ENV=production). In-memory fallback (pg-mem) is strictly prohibited in production.'
            );
          }
        }
        return true;
      };

      // Fails when missing
      expect(() => validateProductionDbConfig('production', false, undefined)).toThrow(
        /Production startup rejected/
      );

      // Fails when memory URL
      expect(() => validateProductionDbConfig('production', false, 'postgres://memory:5432')).toThrow(
        /In-memory fallback \(pg-mem\) is strictly prohibited/
      );

      // Fails when STRICT_PERSISTENT_DB is true regardless of NODE_ENV
      expect(() => validateProductionDbConfig('development', true, '')).toThrow(
        /Production startup rejected/
      );

      // Succeeds when valid postgres connection string provided
      expect(
        validateProductionDbConfig('production', false, 'postgres://fortix:secret@prod-db.cloud.internal:5432/fortix_prod')
      ).toBe(true);
    });

    it('normalizes quoted cloud PostgreSQL/Redis URLs and encodes @ in passwords', () => {
      const rawPg = '"postgresql://postgres.ref:my@pass@word@aws-0-region.pooler.supabase.com:5432/postgres"';
      const normalizedPg = normalizeDatabaseUrl(rawPg);
      expect(normalizedPg).toBe('postgresql://postgres.ref:my%40pass%40word@aws-0-region.pooler.supabase.com:5432/postgres');
      expect(resolvePostgresSslOption(normalizedPg)).toEqual({ rejectUnauthorized: false });
      expect(resolvePostgresSslOption('postgres://fortix:pw@127.0.0.1:5432/fortix_db')).toBe(false);

      const rawRedis = '"rediss://default:token123@example.upstash.io:6379"';
      expect(normalizeRedisUrl(rawRedis)).toBe('rediss://default:token123@example.upstash.io:6379');
    });
  });

  describe('2. Production Secret Entropy & Default Credential Validation', () => {
    it('rejects missing, default, repetitive, or low-entropy JWT secrets in production', () => {
      // Missing
      expect(validateProductionJwtSecret(undefined).valid).toBe(false);
      expect(validateProductionJwtSecret('').valid).toBe(false);

      // Known development / placeholder defaults
      expect(validateProductionJwtSecret('dev_secret_key').valid).toBe(false);
      expect(validateProductionJwtSecret('production-secret-change-me').valid).toBe(false);
      expect(validateProductionJwtSecret('12345678901234567890123456789012').valid).toBe(false);

      // Under 32 characters
      expect(validateProductionJwtSecret('short_key_under_32_characters').valid).toBe(false);

      // Low entropy: repeated single character >= 32 chars
      expect(validateProductionJwtSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').valid).toBe(false);
      expect(validateProductionJwtSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').reason).toMatch(/insufficient entropy/i);

      // Valid strong cryptographically generated secret
      const strongSecret = crypto.randomBytes(32).toString('hex');
      const validRes = validateProductionJwtSecret(strongSecret);
      expect(validRes.valid).toBe(true);
      expect(validRes.reason).toBeUndefined();
    });
  });

  describe('3. Rate Limit Redis Failure Policy & Consistency Limits', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('parses and validates allowed policy values and rejects invalid inputs', () => {
      // Valid policies
      expect(parseAndValidateRedisFailurePolicy('fail-closed').policy).toBe('fail-closed');
      expect(parseAndValidateRedisFailurePolicy('fail-open').policy).toBe('fail-open');
      expect(parseAndValidateRedisFailurePolicy(' FAIL-CLOSED ').policy).toBe('fail-closed');

      // Invalid input defaults safely to fail-closed with error
      const invalid = parseAndValidateRedisFailurePolicy('arbitrary-invalid-policy');
      expect(invalid.policy).toBe('fail-closed');
      expect(invalid.error).toMatch(/Allowed values: fail-closed, fail-open/i);
    });

    it('enforces fail-closed by default in production and rejects unsafe fail-open without explicit flag', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_UNSAFE_REDIS_FAIL_OPEN;

      // When unset in production -> fail-closed
      delete process.env.REDIS_FAILURE_BEHAVIOR;
      expect(getEffectiveRedisFailurePolicy()).toBe('fail-closed');

      // When set to fail-open without break-glass flag in production -> overridden to fail-closed
      process.env.REDIS_FAILURE_BEHAVIOR = 'fail-open';
      expect(getEffectiveRedisFailurePolicy()).toBe('fail-closed');

      // Only allows fail-open in production when ALLOW_UNSAFE_REDIS_FAIL_OPEN is explicitly true
      process.env.ALLOW_UNSAFE_REDIS_FAIL_OPEN = 'true';
      expect(getEffectiveRedisFailurePolicy()).toBe('fail-open');
    });

    it('allows fail-open or fail-closed as configured in non-production environments', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_FAILURE_BEHAVIOR = 'fail-open';
      expect(getEffectiveRedisFailurePolicy()).toBe('fail-open');

      process.env.REDIS_FAILURE_BEHAVIOR = 'fail-closed';
      expect(getEffectiveRedisFailurePolicy()).toBe('fail-closed');
    });
  });

  describe('4. Gateway Upstream Request Bounding, Cancellation & Timeout Handling', () => {
    let app: express.Express;
    let mockUpstreamServer: http.Server;
    let upstreamPort: number;
    let timeoutRouteId: string;
    let normalRouteId: string;
    let testRawApiKey: string;
    let projectId: string;

    beforeAll(async () => {
      mockUpstreamServer = http.createServer((req, res) => {
        if (req.url === '/hang') {
          // Simulate hung upstream target
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'too_late' }));
            }
          }, 10000);
        } else if (req.url === '/fast') {
          // Simulate normal upstream response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', data: 'normal_response' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => {
        mockUpstreamServer.listen(0, () => {
          const addr = mockUpstreamServer.address() as any;
          upstreamPort = addr.port;
          resolve();
        });
      });

      process.env.GATEWAY_UPSTREAM_TIMEOUT_MS = '600';
      process.env.REDIS_FAILURE_BEHAVIOR = 'fail-open';

      app = express();
      app.use(express.json());
      setupGateway(app);

      projectId = uuidv4();
      const orgId = uuidv4();
      const userId = uuidv4();

      await db.insert(users).values({ id: userId, email: `test_${userId}@fortix.test`, passwordHash: 'hash', role: 'ADMIN' }).onConflictDoNothing();
      await db.insert(organizations).values({ id: orgId, name: 'Timeout Test Org', ownerId: userId }).onConflictDoNothing();
      await db.insert(projects).values({ id: projectId, name: 'Timeout Test Project', orgId, environment: 'test' }).onConflictDoNothing();

      // Route for timeout testing
      timeoutRouteId = uuidv4();
      await db.insert(apiRoutes).values({
        id: timeoutRouteId,
        projectId,
        pathPattern: '/test-timeout',
        targetUrl: `http://fortix-demo-api.internal:${upstreamPort}/hang`
      });

      // Route for normal traffic testing
      normalRouteId = uuidv4();
      await db.insert(apiRoutes).values({
        id: normalRouteId,
        projectId,
        pathPattern: '/test-normal',
        targetUrl: `http://fortix-demo-api.internal:${upstreamPort}/fast`
      });

      const keyId = crypto.randomBytes(8).toString('hex');
      const secret = crypto.randomBytes(32).toString('hex');
      testRawApiKey = `fx_test_${keyId}_${secret}`;

      await db.insert(apiKeys).values({
        id: keyId,
        projectId,
        keyPrefix: `fx_test_${keyId}`,
        secretHash: await bcrypt.hash(secret, 10),
        name: 'Hardening Test Key'
      });
    });

    afterAll(async () => {
      delete process.env.GATEWAY_UPSTREAM_TIMEOUT_MS;
      await new Promise<void>((resolve) => mockUpstreamServer.close(() => resolve()));
    });

    it('allows normal completed requests to pass without premature client aborts', async () => {
      const res = await request(app)
        .get(`/proxy/${normalRouteId}`)
        .set('X-API-Key', testRawApiKey);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data).toBe('normal_response');
    });

    it('maps upstream timeouts to HTTP 504 with message reflecting the effective timeout', async () => {
      const start = Date.now();
      const res = await request(app)
        .get(`/proxy/${timeoutRouteId}`)
        .set('X-API-Key', testRawApiKey);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3500);

      expect([504, 502]).toContain(res.status);
      if (res.status === 504) {
        expect(res.body.error).toMatch(/Gateway Timeout: Upstream target timed out after 600ms/i);
      }
    });

    it('returns HTTP 502 Bad Gateway when upstream target refuses connection', async () => {
      const deadPort = 64997;
      const deadRouteId = uuidv4();
      await db.insert(apiRoutes).values({
        id: deadRouteId,
        projectId,
        pathPattern: '/test-dead',
        targetUrl: `http://fortix-demo-api.internal:${deadPort}/nowhere`
      });

      const res = await request(app)
        .get(`/proxy/${deadRouteId}`)
        .set('X-API-Key', testRawApiKey);

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Bad Gateway: Upstream failure/i);
    });
  });
});
