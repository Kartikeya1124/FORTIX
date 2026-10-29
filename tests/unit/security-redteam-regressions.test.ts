import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dns from 'dns';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import { Writable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';

import { setupApiRoutes } from '../../src/api/index.js';
import { setupGateway, apiKeyCache, invalidateExpCache } from '../../src/gateway/index.js';
import { db } from '../../src/db/index.js';
import {
  users,
  organizations,
  projects,
  apiRoutes,
  apiKeys,
  experiments,
  securityPolicies,
  verifications,
  authActionTokens,
} from '../../src/db/schema.js';
import { isSafeTarget, safeDnsLookup } from '../../src/gateway/ssrf.js';
import { securityGuard } from '../../src/services/SecurityGuard.js';
import { verifyAndResolveJwtUser, getJwtSecret } from '../../src/lib/jwt-security.js';
import { issueAuthActionToken, hashActionToken } from '../../src/lib/auth-tokens.js';
import { resolveGatewayPort } from '../../src/lib/port.js';
import {
  verifyWebhookSignature,
  generateWebhookSignature,
  executeWebhookDelivery,
} from '../../src/lib/webhooks.js';
import { recordDlqFailure, __clearDlqStoreForTests } from '../../src/lib/dlq.js';
import { LocalStorageProvider } from '../../src/storage/local-storage.js';
import { REDACTED_LOG_PATHS } from '../../src/lib/logger.js';

describe('FortiX Red-Team Security & Reliability Regressions', () => {
  const app = express();
  app.use(express.json());
  setupApiRoutes(app);
  setupGateway(app);

  const passwordPlain = 'InitialStrongPass!234';
  let currentPasswordA = passwordPlain;
  let passwordHashA = '';
  let passwordHashB = '';

  const tenantA = {
    userId: uuidv4(),
    email: `redteam-a-${Date.now()}@fortix.test`,
    orgId: uuidv4(),
    projectId: uuidv4(),
    routeId: uuidv4(),
    policyId: uuidv4(),
    expId: uuidv4(),
    verificationId: uuidv4(),
    token: '',
    rawApiKey: '',
    keyId: '',
  };

  const tenantB = {
    userId: uuidv4(),
    email: `redteam-b-${Date.now()}@fortix.test`,
    orgId: uuidv4(),
    projectId: uuidv4(),
    token: '',
  };

  let tempStorageDir = '';

  beforeAll(async () => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fortix-artifacts-test-'));
    passwordHashA = await bcrypt.hash(passwordPlain, 10);
    passwordHashB = await bcrypt.hash(passwordPlain, 10);

    await db.insert(users).values([
      { id: tenantA.userId, email: tenantA.email, passwordHash: passwordHashA, role: 'ADMIN' },
      { id: tenantB.userId, email: tenantB.email, passwordHash: passwordHashB, role: 'ADMIN' },
    ]);

    await db.insert(organizations).values([
      { id: tenantA.orgId, name: 'RedTeam Org A', ownerId: tenantA.userId },
      { id: tenantB.orgId, name: 'RedTeam Org B', ownerId: tenantB.userId },
    ]);

    await db.insert(projects).values([
      { id: tenantA.projectId, name: 'Protected Project A', orgId: tenantA.orgId, environment: 'production' },
      { id: tenantB.projectId, name: 'Attacker Project B', orgId: tenantB.orgId, environment: 'development' },
    ]);

    await db.insert(apiRoutes).values({
      id: tenantA.routeId,
      projectId: tenantA.projectId,
      pathPattern: '/v1/redteam',
      targetUrl: 'http://fortix-demo-api:3001/health',
    });

    await db.insert(securityPolicies).values({
      id: tenantA.policyId,
      routeId: tenantA.routeId,
      rateLimitRpm: 120,
      enableWaf: true,
      enableSsrf: true,
    });

    await db.insert(experiments).values({
      id: tenantA.expId,
      routeId: tenantA.routeId,
      type: 'latency',
      status: 'COMPLETED',
      config: { latencyMs: 100 },
    });

    await db.insert(verifications).values({
      id: tenantA.verificationId,
      experimentId: tenantA.expId,
      expected: { maxLatencyMs: 500 },
      observed: { avgLatencyMs: 110 },
      verdict: 'PASSED',
      pdfS3Url: 'original-tenant-a-key.pdf',
    });

    const keyId = crypto.randomBytes(8).toString('hex');
    const keySecret = crypto.randomBytes(32).toString('hex');
    tenantA.keyId = keyId;
    tenantA.rawApiKey = `fx_live_${keyId}_${keySecret}`;
    await db.insert(apiKeys).values({
      id: keyId,
      projectId: tenantA.projectId,
      keyPrefix: `fx_live_${keyId}`,
      secretHash: await bcrypt.hash(keySecret, 10),
      name: 'RedTeam Gateway Key',
    });

    const loginA = await request(app).post('/api/auth/login').send({ email: tenantA.email, password: passwordPlain });
    expect(loginA.status).toBe(200);
    tenantA.token = loginA.body.token;

    const loginB = await request(app).post('/api/auth/login').send({ email: tenantB.email, password: passwordPlain });
    expect(loginB.status).toBe(200);
    tenantB.token = loginB.body.token;
  });

  afterAll(async () => {
    __clearDlqStoreForTests();
    await db.delete(users).where(eq(users.id, tenantA.userId));
    await db.delete(users).where(eq(users.id, tenantB.userId));
    if (tempStorageDir && fs.existsSync(tempStorageDir)) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  it('FX-SEC-001: blocks cross-tenant BOLA/IDOR when X-FortiX-Project-Id header differs from URL/query/body projectId', async () => {
    // 1. Attempt cross-tenant rename via header override
    const patchRes = await request(app)
      .patch(`/api/control/projects/${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .set('X-FortiX-Project-Id', tenantB.projectId)
      .send({ name: 'Hijacked By Tenant B' });
    expect(patchRes.status).toBe(403);

    // 2. Attempt cross-tenant policy downgrade via header override
    const policyRes = await request(app)
      .put(`/api/control/projects/${tenantA.projectId}/policies`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .set('X-FortiX-Project-Id', tenantB.projectId)
      .send({ ssrfProtectionEnabled: false, wafEnabled: false });
    expect(policyRes.status).toBe(403);

    // 3. Attempt cross-tenant settings overwrite via query vs header mismatch
    const settingsRes = await request(app)
      .patch(`/api/control/settings/security?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .set('X-FortiX-Project-Id', tenantB.projectId)
      .send({ ssrfProtection: false, threatDetection: false });
    expect(settingsRes.status).toBe(403);

    // 4. Attempt cross-tenant project deletion via header override
    const deleteRes = await request(app)
      .delete(`/api/control/projects/${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .set('X-FortiX-Project-Id', tenantB.projectId);
    expect(deleteRes.status).toBe(403);

    // Confirm Tenant A's project is completely intact
    const [projCheck] = await db.select().from(projects).where(eq(projects.id, tenantA.projectId));
    expect(projCheck).toBeDefined();
    expect(projCheck.name).toBe('Protected Project A');
  });

  it('FX-SEC-002: blocks SSRF demo-host port scanning, trailing dots, embedded credentials, expanded IPv6/NAT64, and DNS rebinding', async () => {
    const blockedTargets = [
      'http://fortix-demo-api:6379/info',
      'http://fortix-demo-api:5432/',
      'http://fortix-demo-api.evil.com/api',
      'http://localhost./admin',
      'http://metadata.google.internal./computeMetadata/v1/',
      'http://user:password@93.184.216.34/secret',
      'http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/',
      'http://[fe80::1%25eth0]/',
    ];

    for (const target of blockedTargets) {
      expect(isSafeTarget(target), `isSafeTarget should block ${target}`).toBe(false);
      const sgRes = await securityGuard.validateTarget(target);
      expect(sgRes.isValid, `SecurityGuard should block ${target}`).toBe(false);
    }

    // Legitimate demo API port 3001 remains permitted in non-production
    expect(isSafeTarget('http://fortix-demo-api:3001/health')).toBe(true);
    expect(isSafeTarget('http://fortix-demo-api.internal/health')).toBe(true);

    // Verify connection-time safeDnsLookup blocks 0-TTL DNS rebinding to 127.0.0.1
    const lookupSpy = vi.spyOn(dns, 'lookup').mockImplementation(((
      _host: string,
      _opts: any,
      cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
    ) => {
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as any);

    try {
      const rebindErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        safeDnsLookup('rebind-test.example.org', { all: true }, (err) => resolve(err));
      });
      expect(rebindErr).not.toBeNull();
      expect(rebindErr?.code).toBe('ESSRFBLOCKED');
    } finally {
      lookupSpy.mockRestore();
    }
  });

  it('FX-SEC-003: enforces webhook SSRF validation, masks secrets, blocks 302 redirect SSRF, requires signature timestamps, and isolates DLQ per tenant', async () => {
    // 1. Reject internal/SSRF webhook URL on creation
    const badWh = await request(app)
      .post(`/api/control/webhooks?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({
        name: 'Bad Internal Hook',
        url: 'http://127.0.0.1:6379/hook',
        secret: 'whsec_super_sensitive_123',
        events: ['*'],
      });
    expect(badWh.status).toBe(400);

    // 2. Create valid webhook and verify secret is masked on POST & GET
    const createWh = await request(app)
      .post(`/api/control/webhooks?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({
        name: 'Safe Public Hook',
        url: 'https://api.github.com/zen',
        secret: 'whsec_super_sensitive_123',
        events: ['*'],
      });
    expect(createWh.status).toBe(200);
    expect(createWh.body.secret).toBeUndefined();
    expect(createWh.body.hasSecret).toBe(true);

    const listWh = await request(app)
      .get(`/api/control/webhooks?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantA.token}`);
    expect(listWh.status).toBe(200);
    expect(listWh.body[0].secret).toBeUndefined();
    expect(listWh.body[0].hasSecret).toBe(true);

    // 3. Reject replay signature header missing timestamp (`t=`) or `t=0`
    const payload = { event: 'test', ok: true };
    const rawHmac = crypto.createHmac('sha256', 'whsec_test').update(JSON.stringify(payload)).digest('hex');
    expect(verifyWebhookSignature(payload, `v1=${rawHmac}`, 'whsec_test').valid).toBe(false);
    const zeroSig = generateWebhookSignature(payload, 'whsec_test', 0);
    expect(verifyWebhookSignature(payload, zeroSig.signatureHeader, 'whsec_test').valid).toBe(false);

    // 4. Block 302 Redirect SSRF to cloud metadata IP during webhook delivery
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      text: async () => '',
    }) as any;
    try {
      await expect(
        executeWebhookDelivery({
          webhookId: createWh.body.id,
          projectId: tenantA.projectId,
          url: 'https://api.github.com/redirect-sink',
          secret: 'whsec_super_sensitive_123',
          eventType: 'security.test',
          payload: { probe: 1 },
        })
      ).rejects.toThrow(/SSRF blocked webhook redirect/i);
    } finally {
      global.fetch = origFetch;
    }

    // 5. Verify DLQ scrubs secrets and blocks Tenant B from viewing/retrying/purging Tenant A's DLQ job
    __clearDlqStoreForTests();
    await recordDlqFailure({
      jobId: 'dlq-tenant-a-webhook',
      queueName: 'fortix-webhooks',
      jobName: 'deliver-webhook',
      data: {
        projectId: tenantA.projectId,
        webhookId: createWh.body.id,
        secret: 'whsec_super_sensitive_123',
      },
      failedReason: 'Simulated upstream timeout',
    });

    const ownerDlq = await request(app)
      .get('/api/control/dlq')
      .set('Authorization', `Bearer ${tenantA.token}`);
    expect(ownerDlq.status).toBe(200);
    expect(ownerDlq.body.total).toBe(1);
    expect(ownerDlq.body.jobs[0].data.secret).toBe('[REDACTED]');

    const foreignList = await request(app)
      .get('/api/control/dlq')
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.total).toBe(0);

    const foreignGet = await request(app)
      .get('/api/control/dlq/dlq-tenant-a-webhook')
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(foreignGet.status).toBe(403);

    const foreignRetry = await request(app)
      .post('/api/control/dlq/dlq-tenant-a-webhook/retry')
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(foreignRetry.status).toBe(403);

    const foreignPurge = await request(app)
      .delete('/api/control/dlq/purge-all')
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(foreignPurge.status).toBe(200);
    expect(foreignPurge.body.purgedCount).toBe(0);
  });

  it('FX-SEC-004: hashes cached API keys, enforces cached key expiry, blocks pre-auth fault delays, and invalidates rotated keys', async () => {
    apiKeyCache.clear();

    // Populate cache via gateway request
    const authPassRes = await request(app)
      .get(`/proxy/${tenantA.routeId}`)
      .set('X-API-Key', tenantA.rawApiKey);
    expect(authPassRes.status).not.toBe(401);

    // Raw key is NEVER stored as a raw string in Map keys, and secretHash is stripped
    const rawMapKeys = Array.from(Map.prototype.keys.call(apiKeyCache));
    expect(rawMapKeys.length).toBe(1);
    expect(rawMapKeys[0]).not.toContain('fx_');
    expect(rawMapKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(apiKeyCache.has(tenantA.rawApiKey)).toBe(true);
    expect(apiKeyCache.get(tenantA.rawApiKey)?.key?.secretHash).toBeUndefined();

    // Mutate cached entry's expiresAt into the past and verify cache hit rejects expired key immediately
    const cachedEntry = apiKeyCache.get(tenantA.rawApiKey)!;
    apiKeyCache.set(tenantA.rawApiKey, {
      key: { ...cachedEntry.key, expiresAt: new Date(Date.now() - 5000).toISOString() },
      cachedAt: Date.now(),
    });
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 5000) })
      .where(eq(apiKeys.id, tenantA.keyId));

    const expiredRes = await request(app)
      .get(`/proxy/${tenantA.routeId}`)
      .set('X-API-Key', tenantA.rawApiKey);
    expect(expiredRes.status).toBe(401);

    // Restore non-expired state
    await db.update(apiKeys).set({ expiresAt: null }).where(eq(apiKeys.id, tenantA.keyId));
    apiKeyCache.clear();

    // Inject active 5xx + latency experiment and verify unauthenticated caller gets immediate 401 (not 503 / delay)
    const faultExpId = uuidv4();
    await db.insert(experiments).values({
      id: faultExpId,
      routeId: tenantA.routeId,
      type: 'error_5xx',
      status: 'RUNNING',
      config: { latencyMs: 3000 },
    });
    invalidateExpCache(tenantA.routeId);

    const t0 = Date.now();
    const unauthUnderFault = await request(app).get(`/proxy/${tenantA.routeId}`);
    const elapsedMs = Date.now() - t0;
    expect(unauthUnderFault.status).toBe(401);
    expect(elapsedMs).toBeLessThan(1000);

    await db.delete(experiments).where(eq(experiments.id, faultExpId));
    invalidateExpCache(tenantA.routeId);

    // Rotate API key and verify old key fails immediately while new key passes
    const oldRawKey = tenantA.rawApiKey;
    const rotateRes = await request(app)
      .post(`/api/control/keys/${tenantA.keyId}/rotate`)
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({ projectId: tenantA.projectId });
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.rawKey).toMatch(/^fx_/);

    const oldKeyAttempt = await request(app)
      .get(`/proxy/${tenantA.routeId}`)
      .set('X-API-Key', oldRawKey);
    expect(oldKeyAttempt.status).toBe(401);

    tenantA.rawApiKey = rotateRes.body.rawKey;
    const newKeyAttempt = await request(app)
      .get(`/proxy/${tenantA.routeId}`)
      .set('X-API-Key', tenantA.rawApiKey);
    expect(newKeyAttempt.status).not.toBe(401);
  });

  it('FX-SEC-005: rejects forged dev-secret JWTs, revokes logged-out JWTs, and invalidates pre-existing sessions on password rotation', async () => {
    // 1. Forged token using legacy hardcoded 'dev-secret' must be rejected
    const forgedDevToken = jwt.sign({ id: tenantA.userId, email: tenantA.email, role: 'ADMIN' }, 'dev-secret', {
      algorithm: 'HS256',
    });
    const forgedUser = await verifyAndResolveJwtUser(forgedDevToken);
    expect(forgedUser).toBeNull();

    // 2. Logout revokes that specific JWT server-side
    const tempLogin = await request(app).post('/api/auth/login').send({ email: tenantA.email, password: passwordPlain });
    const sessionToken = tempLogin.body.token;
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${sessionToken}`)).status).toBe(200);

    const logoutRes = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${sessionToken}`);
    expect(logoutRes.status).toBe(200);

    const afterLogout = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${sessionToken}`);
    expect(afterLogout.status).toBe(401);

    // 3. Password change invalidates older active tokens and issues a fresh working token
    const preChangeToken = tenantA.token;
    const nextPassword = 'RotatedStrongPass!789';
    const pwdRes = await request(app)
      .post('/api/control/account/password')
      .set('Authorization', `Bearer ${preChangeToken}`)
      .send({ currentPassword: passwordPlain, newPassword: nextPassword });
    expect(pwdRes.status).toBe(200);
    expect(pwdRes.body.token).toBeDefined();

    const staleSessionRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${preChangeToken}`);
    expect(staleSessionRes.status).toBe(401);

    currentPasswordA = nextPassword;
    tenantA.token = pwdRes.body.token;
    const freshSessionRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tenantA.token}`);
    expect(freshSessionRes.status).toBe(200);
  });

  it('FX-SEC-006: blocks cross-tenant verification pdfS3Url tampering and preserves local artifacts across cold instance restarts', async () => {
    // Tenant B tries to overwrite Tenant A's verificationId record using Tenant B's own projectId
    const hijackReport = await request(app)
      .post(`/api/control/reports/${tenantA.verificationId}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .send({ projectId: tenantB.projectId, details: 'Malicious report overwrite' });
    expect(hijackReport.status).toBe(403);

    const [verifRow] = await db.select().from(verifications).where(eq(verifications.id, tenantA.verificationId));
    expect(verifRow.pdfS3Url).toBe('original-tenant-a-key.pdf');

    // Simulate process restart with fresh LocalStorageProvider instance pointing to the same disk directory
    const writerStore = new LocalStorageProvider({ baseDirectory: tempStorageDir });
    const samplePdf = Buffer.from('%PDF-1.4\nFortiX restart durability verification artifact\n%%EOF');
    const savedMeta = await writerStore.put(samplePdf, {
      projectId: tenantA.projectId,
      verificationId: tenantA.verificationId,
      filename: 'Restart-Durability.pdf',
      contentType: 'application/pdf',
    });

    const restartedReaderStore = new LocalStorageProvider({ baseDirectory: tempStorageDir });
    const listedAfterRestart = await restartedReaderStore.listByProject(tenantA.projectId);
    expect(listedAfterRestart.some((m) => m.artifactId === savedMeta.artifactId)).toBe(true);

    const fetchedByIdAfterRestart = await restartedReaderStore.get(savedMeta.artifactId, tenantA.projectId);
    expect(fetchedByIdAfterRestart).not.toBeNull();
    expect(fetchedByIdAfterRestart?.metadata.sha256).toBe(savedMeta.sha256);
    expect(fetchedByIdAfterRestart?.data.equals(samplePdf)).toBe(true);
  });

  it('FX-SEC-007: handles malformed percent-encoding without URIError 500, blocks SQLi boolean tautologies, and redacts credentials in Pino logs', async () => {
    // 1. Malformed '%' in query does NOT throw unhandled URIError 500
    const malformedRes = await request(app)
      .get(`/proxy/${tenantA.routeId}?q=%E0%A4%A&pct=%`)
      .set('X-API-Key', tenantA.rawApiKey);
    expect(malformedRes.status).not.toBe(500);

    // 2. Classic boolean SQLi (' OR 1=1--) is blocked with 403 by WAF
    const sqliRes = await request(app)
      .get(`/proxy/${tenantA.routeId}?query=admin%27%20OR%201=1--`)
      .set('X-API-Key', tenantA.rawApiKey);
    expect(sqliRes.status).toBe(403);

    // 3. Structured Pino redaction censors Authorization, API keys, passwords, and secrets
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const testLogger = pino({ redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' } }, sink);
    testLogger.info({
      req: {
        headers: {
          authorization: 'Bearer super_secret_jwt_value',
          'x-api-key': 'fx_live_12345678_rawsecret',
          'x-fortix-token': 'jwt_custom_header_secret',
        },
      },
      password: 'PlainPassword123!',
      data: { secret: 'whsec_raw_secret_value' },
    });

    const output = chunks.join('');
    expect(output).not.toContain('super_secret_jwt_value');
    expect(output).not.toContain('fx_live_12345678_rawsecret');
    expect(output).not.toContain('jwt_custom_header_secret');
    expect(output).not.toContain('PlainPassword123!');
    expect(output).not.toContain('whsec_raw_secret_value');
    expect(output).toContain('[REDACTED]');
  });

  it('FX-SEC-008: resolves Cloud Run PORT=8080 when K_SERVICE is set while keeping dev preview on 3000, and generates 256-bit runtime JWT secret in Cloud Run', () => {
    // Cloud Run runtime (K_SERVICE set, PORT=8080) must bind 8080 regardless of NODE_ENV
    expect(resolveGatewayPort(['node', 'dist/server.cjs'], { K_SERVICE: 'fortix-cloudrun', PORT: '8080' } as any)).toBe(8080);
    expect(resolveGatewayPort(['node', 'dist/server.cjs'], { NODE_ENV: 'production', PORT: '8080' } as any)).toBe(8080);

    // AI Studio dev preview (no K_SERVICE, non-production, internal PORT=8080) must bind 3000
    expect(resolveGatewayPort(['tsx', 'server.ts'], { NODE_ENV: 'development', PORT: '8080' } as any)).toBe(3000);

    // Production without JWT_SECRET generates a strong 64-hex-char secret unless STRICT_PRODUCTION_SECRETS=true
    const origNodeEnv = process.env.NODE_ENV;
    const origSecret = process.env.JWT_SECRET;
    const origStrict = process.env.STRICT_PRODUCTION_SECRETS;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      process.env.STRICT_PRODUCTION_SECRETS = 'true';
      expect(() => getJwtSecret()).toThrow(/JWT_SECRET must be set/i);

      delete process.env.STRICT_PRODUCTION_SECRETS;
      delete process.env.JWT_SECRET;
      const generated = getJwtSecret();
      expect(generated).toMatch(/^[a-f0-9]{64}$/);
      expect(getJwtSecret()).toBe(generated);
    } finally {
      if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
      else delete process.env.NODE_ENV;
      if (origSecret !== undefined) process.env.JWT_SECRET = origSecret;
      else delete process.env.JWT_SECRET;
      if (origStrict !== undefined) process.env.STRICT_PRODUCTION_SECRETS = origStrict;
      else delete process.env.STRICT_PRODUCTION_SECRETS;
    }
  });

  it('FX-SEC-009: enforces least-privilege DEVELOPER role on registration and blocks non-ADMIN users from /api/control/admin/*', async () => {
    const regEmail = `least-priv-${Date.now()}@fortix.test`;
    const regPassword = 'StrongOperatorPassword!2026';

    // Attempt privilege escalation by injecting role: 'ADMIN' in registration body
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: regEmail, password: regPassword, name: 'Ordinary Registrant', role: 'ADMIN' });

    expect(regRes.status).toBe(201);
    expect(regRes.body.user.role).toBe('DEVELOPER');
    expect(regRes.body.user.emailVerified).toBe(false);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: regEmail, password: regPassword });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe('DEVELOPER');

    const devToken = loginRes.body.token;

    // DEVELOPER user must be denied administrative endpoints
    const adminListDenied = await request(app)
      .get('/api/control/admin/users')
      .set('Authorization', `Bearer ${devToken}`);
    expect(adminListDenied.status).toBe(403);
    expect(adminListDenied.body.code).toBe('ADMIN_ROLE_REQUIRED');

    const selfPromoteDenied = await request(app)
      .patch(`/api/control/admin/users/${regRes.body.user.id}/role`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ role: 'ADMIN' });
    expect(selfPromoteDenied.status).toBe(403);

    // Genuine ADMIN user (tenantA) can query admin endpoint, and cannot self-demote
    const adminTokenLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: tenantA.email, password: currentPasswordA });
    expect(adminTokenLogin.status).toBe(200);

    const adminListAllowed = await request(app)
      .get('/api/control/admin/users')
      .set('Authorization', `Bearer ${adminTokenLogin.body.token}`);
    expect(adminListAllowed.status).toBe(200);
    expect(Array.isArray(adminListAllowed.body.users)).toBe(true);

    const selfDemoteBlocked = await request(app)
      .patch(`/api/control/admin/users/${tenantA.userId}/role`)
      .set('Authorization', `Bearer ${adminTokenLogin.body.token}`)
      .send({ role: 'DEVELOPER' });
    expect(selfDemoteBlocked.status).toBe(400);
  });

  it('FX-SEC-010: issues HttpOnly session cookies, enforces Double-Submit CSRF & Origin allowlist, revokes cookie sessions on logout, and eliminates localStorage tokens', async () => {
    // 1. Verify frontend source files never store or read fortix_token in localStorage
    const loginSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/Login.tsx'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/api.ts'), 'utf8');
    const socketSrc = fs.readFileSync(path.join(process.cwd(), 'src/context/SocketContext.tsx'), 'utf8');

    expect(loginSrc).not.toContain('fortix_token');
    expect(apiSrc).not.toMatch(/localStorage\.(getItem|setItem)\(['"]fortix_token['"]/);
    expect(socketSrc).not.toContain('fortix_token');

    // 2. Login issues HttpOnly fortix_session cookie and fortix_csrf cookie
    const agent = request.agent(app);
    const loginRes = await agent
      .post('/api/auth/login')
      .send({ email: tenantA.email, password: currentPasswordA });

    expect(loginRes.status).toBe(200);
    const setCookies = loginRes.headers['set-cookie'] as unknown as string[];
    expect(Array.isArray(setCookies)).toBe(true);
    const sessionCookieRaw = setCookies.find((c) => c.startsWith('fortix_session='));
    const csrfCookieRaw = setCookies.find((c) => c.startsWith('fortix_csrf='));
    expect(sessionCookieRaw).toBeDefined();
    expect(sessionCookieRaw).toMatch(/HttpOnly/i);
    expect(csrfCookieRaw).toBeDefined();

    const csrfToken = loginRes.body.csrfToken;
    expect(csrfToken).toMatch(/^[a-f0-9]{64}$/i);

    // 3. GET /api/auth/me succeeds solely via HttpOnly cookie (no Authorization header)
    const meRes = await agent.get('/api/auth/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.id).toBe(tenantA.userId);

    // 4. State-changing cookie request WITHOUT X-CSRF-Token is rejected with 403
    const csrfMissingRes = await agent
      .post('/api/control/projects')
      .send({ name: 'Forged CSRF Project' });
    expect(csrfMissingRes.status).toBe(403);
    expect(csrfMissingRes.body.code).toBe('CSRF_TOKEN_INVALID');

    // 5. State-changing cookie request WITH X-CSRF-Token from untrusted Origin is rejected with 403
    const untrustedOriginRes = await agent
      .post('/api/control/projects')
      .set('Origin', 'https://evil-attacker.example.com')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Cross-Origin Forged Project' });
    expect(untrustedOriginRes.status).toBe(403);
    expect(untrustedOriginRes.body.code).toBe('CSRF_ORIGIN_DENIED');

    // 6. State-changing cookie request WITH matching X-CSRF-Token succeeds
    const validCookiePost = await agent
      .post('/api/control/projects')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Authorized Cookie Project' });
    expect(validCookiePost.status).toBe(201);

    // 7. Capture raw session cookie, logout, and prove captured cookie cannot be replayed
    const capturedSessionHeader = sessionCookieRaw!.split(';')[0];
    const logoutRes = await agent
      .post('/api/auth/logout')
      .set('X-CSRF-Token', csrfToken);
    expect(logoutRes.status).toBe(200);

    const replayAfterLogout = await request(app)
      .get('/api/auth/me')
      .set('Cookie', capturedSessionHeader);
    expect(replayAfterLogout.status).toBe(401);
  });

  it('FX-SEC-011: enforces non-enumerating, SHA-256 hashed, expiring, single-use password reset and email verification tokens', async () => {
    const userEmail = `recovery-${Date.now()}@fortix.test`;
    const initialPass = 'InitialRecoveryPass!123';
    const updatedPass = 'RotatedRecoveryPass!999';

    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: userEmail, password: initialPass });
    expect(regRes.status).toBe(201);
    const userId = regRes.body.user.id;
    const devVerifyToken = regRes.body.devVerificationToken;
    expect(devVerifyToken).toMatch(/^[a-f0-9]{64}$/);

    // 1. Non-enumerating forgot-password response for unknown vs registered email
    const unknownForgot = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: `nonexistent-${Date.now()}@fortix.test` });
    const knownForgot = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: userEmail });

    expect(unknownForgot.status).toBe(200);
    expect(knownForgot.status).toBe(200);
    expect(unknownForgot.body.message).toBe(knownForgot.body.message);
    expect(unknownForgot.body.devResetToken).toBeUndefined();

    const rawResetToken = knownForgot.body.devResetToken as string;
    expect(rawResetToken).toMatch(/^[a-f0-9]{64}$/);

    // 2. Verify plaintext token is NEVER stored in database (only SHA-256 hash)
    const storedTokens = await db
      .select()
      .from(authActionTokens)
      .where(eq(authActionTokens.userId, userId));
    expect(storedTokens.some((t) => t.tokenHash === rawResetToken)).toBe(false);
    expect(storedTokens.some((t) => t.tokenHash === hashActionToken(rawResetToken))).toBe(true);

    // 3. Expired token is rejected
    const expiredIssued = await issueAuthActionToken(userId, userEmail, 'PASSWORD_RESET', -5000);
    const expiredAttempt = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: expiredIssued.rawToken, newPassword: updatedPass });
    expect(expiredAttempt.status).toBe(400);
    expect(expiredAttempt.body.error).toMatch(/expired/i);

    // 4. Issue fresh valid reset token, consume once, verify password replaced & replay rejected
    const freshReset = await issueAuthActionToken(userId, userEmail, 'PASSWORD_RESET', 60000);
    const resetOk = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: freshReset.rawToken, newPassword: updatedPass });
    expect(resetOk.status).toBe(200);

    // Replay of single-use token must fail
    const replayReset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: freshReset.rawToken, newPassword: 'AnotherPassword!888' });
    expect(replayReset.status).toBe(400);

    // Old password rejected, new password succeeds
    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: userEmail, password: initialPass });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: userEmail, password: updatedPass });
    expect(newLogin.status).toBe(200);

    // 5. Single-use Email Verification token transitions emailVerified -> true and blocks replay
    const verifyOk = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: devVerifyToken });
    expect(verifyOk.status).toBe(200);

    const verifyReplay = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: devVerifyToken });
    expect(verifyReplay.status).toBe(400);

    const meVerified = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${newLogin.body.token}`);
    expect(meVerified.status).toBe(200);
    expect(meVerified.body.user.emailVerified).toBe(true);
  });

  it('FX-SEC-012: enforces re-authorized account deletion with immediate session & API-key revocation, blocks demo logins in production, and returns JSON 404 on unknown /api paths', async () => {
    // 1. Unknown /api/* path returns structured JSON 404 (not HTML)
    const notFoundApi = await request(app).get('/api/non-existent-endpoint-check');
    expect(notFoundApi.status).toBe(404);
    expect(notFoundApi.headers['content-type']).toMatch(/application\/json/i);
    expect(notFoundApi.body.code).toBe('API_ROUTE_NOT_FOUND');

    // 2. Production demo credential blocking
    const origNodeEnv = process.env.NODE_ENV;
    const origAllowDemo = process.env.ALLOW_DEMO_ACCOUNTS;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_DEMO_ACCOUNTS;
      const demoLoginProd = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@fortix.test', password: 'password123' });
      expect(demoLoginProd.status).toBe(401);
    } finally {
      if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
      else delete process.env.NODE_ENV;
      if (origAllowDemo !== undefined) process.env.ALLOW_DEMO_ACCOUNTS = origAllowDemo;
      else delete process.env.ALLOW_DEMO_ACCOUNTS;
    }

    // 3. Account deletion lifecycle
    const delEmail = `delete-me-${Date.now()}@fortix.test`;
    const delPassword = 'DeleteConfirmPass!2026';

    await request(app).post('/api/auth/register').send({ email: delEmail, password: delPassword });
    const loginRes = await request(app).post('/api/auth/login').send({ email: delEmail, password: delPassword });
    const delToken = loginRes.body.token;

    const projRes = await request(app)
      .post('/api/control/projects')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ name: 'Ephemeral Workspace' });
    expect(projRes.status).toBe(201);
    const projId = projRes.body.id;

    const keyRes = await request(app)
      .post('/api/control/keys')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ projectId: projId, name: 'Ephemeral Key' });
    expect(keyRes.status).toBe(201);

    // Wrong password rejected
    const wrongPassDel = await request(app)
      .delete('/api/control/account')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ password: 'WrongPassword!', confirmation: 'DELETE' });
    expect(wrongPassDel.status).toBe(401);

    // Valid deletion revokes token, cascades projects/keys, and deletes user
    const validDel = await request(app)
      .delete('/api/control/account')
      .set('Authorization', `Bearer ${delToken}`)
      .send({ password: delPassword, confirmation: 'DELETE' });
    expect(validDel.status).toBe(200);
    expect(validDel.body.deleted).toBe(true);

    // Old token immediately fails
    const postDeleteMe = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${delToken}`);
    expect(postDeleteMe.status).toBe(401);

    // Project and API keys cascaded
    const remainingKeys = await db.select().from(apiKeys).where(eq(apiKeys.projectId, projId));
    expect(remainingKeys.length).toBe(0);
  });
});
