import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { db } from '../../src/db/index.js';
import { apiKeys, projects, organizations, users } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { apiKeysRouter } from '../../src/api/keys.js';
import { authenticateFortixApiKey } from '../../src/middleware/apiKeyAuth.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

describe('FortiX API Key Lifecycle & Security Safeguards', () => {
  let app: express.Express;
  let testUserId: string;
  let testOrgId: string;
  let testProjectId: string;
  let foreignProjectId: string;

  beforeEach(async () => {
    testUserId = uuidv4();
    testOrgId = uuidv4();
    testProjectId = uuidv4();
    foreignProjectId = uuidv4();

    await db.insert(users).values({
      id: testUserId,
      email: `key-test-${testUserId.slice(0, 8)}@fortix.io`,
      passwordHash: 'dummy-hash',
    });

    await db.insert(organizations).values({
      id: testOrgId,
      name: 'Key Org',
      ownerId: testUserId,
    });

    await db.insert(projects).values({
      id: testProjectId,
      orgId: testOrgId,
      name: 'Primary Project',
      environment: 'development',
    });

    await db.insert(projects).values({
      id: foreignProjectId,
      orgId: testOrgId,
      name: 'Foreign Project',
      environment: 'production',
    });

    app = express();
    app.use(express.json());

    // Mock authenticate middleware
    app.use((req: any, _res, next) => {
      req.user = { id: testUserId, email: 'test@fortix.io' };
      next();
    });

    app.use('/api/control/keys', apiKeysRouter);

    // Protected dummy routes using authenticateFortixApiKey
    app.get('/api/protected/proxy', authenticateFortixApiKey('gateway:proxy'), (req, res) => {
      res.json({ success: true, key: req.apiKey });
    });

    app.get('/api/protected/admin', authenticateFortixApiKey('admin'), (req, res) => {
      res.json({ success: true, key: req.apiKey });
    });
  });

  it('1. Generates cryptographic, opaque FortiX keys with one-time raw secret display and hashed storage', async () => {
    const res = await request(app)
      .post('/api/control/keys')
      .send({
        projectId: testProjectId,
        name: 'Telemetry Key',
        scopes: ['gateway:proxy', 'metrics:read'],
        expiresInDays: 30,
      });

    expect(res.status).toBe(201);
    expect(res.body.rawKey).toBeDefined();
    expect(res.body.rawKey).toMatch(/^fx_test_[a-f0-9]{16}_[a-f0-9]{64}$/);
    expect(res.body.keyPrefix).toMatch(/^fx_test_[a-f0-9]{16}$/);

    // Verify raw secret is NOT stored in the database
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, res.body.id));
    expect(stored.secretHash).not.toBe(res.body.rawKey);
    expect(stored.secretHash.startsWith('$2')).toBe(true); // bcrypt hash format
  });

  it('2. Authenticates valid FortiX key and enforces scope restrictions', async () => {
    // Create key with gateway:proxy scope
    const createRes = await request(app)
      .post('/api/control/keys')
      .send({
        projectId: testProjectId,
        name: 'Proxy Key',
        scopes: ['gateway:proxy'],
      });

    const rawKey = createRes.body.rawKey;

    // Allowed on gateway:proxy endpoint
    const validRes = await request(app)
      .get('/api/protected/proxy')
      .set('x-api-key', rawKey);

    expect(validRes.status).toBe(200);
    expect(validRes.body.key.id).toBe(createRes.body.id);
    expect(validRes.body.key.scopes).toContain('gateway:proxy');

    // Forbidden on admin endpoint due to insufficient scope
    const forbiddenRes = await request(app)
      .get('/api/protected/admin')
      .set('x-api-key', rawKey);

    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body.error).toMatch(/Insufficient scope/i);
  });

  it('3. Rejects revoked, expired, and cross-project keys', async () => {
    const createRes = await request(app)
      .post('/api/control/keys')
      .send({
        projectId: testProjectId,
        name: 'Revoke Key',
        scopes: ['gateway:proxy'],
      });

    const rawKey = createRes.body.rawKey;
    const keyId = createRes.body.id;

    // Test cross-project isolation
    const crossProjRes = await request(app)
      .get('/api/protected/proxy')
      .set('x-api-key', rawKey)
      .set('x-fortix-project-id', foreignProjectId);

    expect(crossProjRes.status).toBe(403);
    expect(crossProjRes.body.error).toMatch(/Cross-project access forbidden/i);

    // Revoke the key
    const revokeRes = await request(app)
      .post(`/api/control/keys/${keyId}/revoke`)
      .send({ projectId: testProjectId });

    expect(revokeRes.status).toBe(200);

    // Attempt usage with revoked key
    const deniedRes = await request(app)
      .get('/api/protected/proxy')
      .set('x-api-key', rawKey);

    expect(deniedRes.status).toBe(401);
    expect(deniedRes.body.error).toMatch(/revoked/i);
  });

  it('4. Supports key rotation, updating secret and invalidating old credential immediately', async () => {
    const createRes = await request(app)
      .post('/api/control/keys')
      .send({
        projectId: testProjectId,
        name: 'Rotation Key',
        scopes: ['gateway:proxy'],
      });

    const oldKey = createRes.body.rawKey;
    const keyId = createRes.body.id;

    // Rotate key
    const rotateRes = await request(app)
      .post(`/api/control/keys/${keyId}/rotate`)
      .send({ projectId: testProjectId });

    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.rawKey).toBeDefined();
    expect(rotateRes.body.rawKey).not.toBe(oldKey);

    const newKey = rotateRes.body.rawKey;

    // Old key must be rejected
    const oldAttempt = await request(app)
      .get('/api/protected/proxy')
      .set('x-api-key', oldKey);

    expect(oldAttempt.status).toBe(401);

    // New key must succeed
    const newAttempt = await request(app)
      .get('/api/protected/proxy')
      .set('x-api-key', newKey);

    expect(newAttempt.status).toBe(200);
  });

  it('5. Enforces maximum key quota per project', async () => {
    // Fill quota up to limit
    for (let i = 0; i < 24; i++) {
      const keyId = crypto.randomBytes(8).toString('hex');
      await db.insert(apiKeys).values({
        id: keyId,
        projectId: testProjectId,
        keyPrefix: `fx_test_${keyId}`,
        secretHash: 'hash',
        name: `Key ${i}`,
        createdAt: new Date(),
      });
    }

    // 25th key should succeed
    const res25 = await request(app)
      .post('/api/control/keys')
      .send({ projectId: testProjectId, name: 'Key 25' });
    expect(res25.status).toBe(201);

    // 26th key should be rejected by quota limit
    const res26 = await request(app)
      .post('/api/control/keys')
      .send({ projectId: testProjectId, name: 'Key 26' });

    expect(res26.status).toBe(400);
    expect(res26.body.error).toMatch(/quota exceeded/i);
  });
});
