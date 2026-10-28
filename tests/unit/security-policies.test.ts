import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupApiRoutes } from '../../src/api/index.js';
import { setupGateway } from '../../src/gateway/index.js';
import { db } from '../../src/db/index.js';
import { users, organizations, projects, apiRoutes, apiKeys, securityPolicies } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const app = express();
app.use(express.json());
setupApiRoutes(app);
setupGateway(app);

describe('Security Policies Control Plane & Runtime Enforcement', () => {
  const jwtSecret = process.env.JWT_SECRET || 'fortix_local_dev_secret_key_32_characters_minimum_entropy';

  const tenantA = {
    userId: uuidv4(),
    email: `sec-policy-a-${Date.now()}@fortix.test`,
    orgId: uuidv4(),
    projectId: uuidv4(),
    routeId: uuidv4(),
    token: '',
    rawApiKey: ''
  };

  const tenantB = {
    userId: uuidv4(),
    email: `sec-policy-b-${Date.now()}@fortix.test`,
    orgId: uuidv4(),
    projectId: uuidv4(),
    token: ''
  };

  let createdPolicyId = '';

  beforeAll(async () => {
    tenantA.token = jwt.sign({ id: tenantA.userId, email: tenantA.email, role: 'ADMIN' }, jwtSecret);
    tenantB.token = jwt.sign({ id: tenantB.userId, email: tenantB.email, role: 'ADMIN' }, jwtSecret);

    await db.insert(users).values([
      { id: tenantA.userId, email: tenantA.email, passwordHash: 'hashed', role: 'ADMIN' },
      { id: tenantB.userId, email: tenantB.email, passwordHash: 'hashed', role: 'ADMIN' }
    ]);

    await db.insert(organizations).values([
      { id: tenantA.orgId, name: 'Org Policy A', ownerId: tenantA.userId },
      { id: tenantB.orgId, name: 'Org Policy B', ownerId: tenantB.userId }
    ]);

    await db.insert(projects).values([
      { id: tenantA.projectId, name: 'Policy Project A', orgId: tenantA.orgId, environment: 'production' },
      { id: tenantB.projectId, name: 'Policy Project B', orgId: tenantB.orgId, environment: 'development' }
    ]);

    await db.insert(apiRoutes).values({
      id: tenantA.routeId,
      projectId: tenantA.projectId,
      pathPattern: '/v1/payments',
      targetUrl: 'http://fortix-demo-api:3001/api/v1/data'
    });

    const keyId = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    tenantA.rawApiKey = `fx_live_${keyId}_${secret}`;
    await db.insert(apiKeys).values({
      id: keyId,
      projectId: tenantA.projectId,
      keyPrefix: `fx_live_${keyId}`,
      secretHash: await bcrypt.hash(secret, 10),
      name: 'Policy Gateway Key'
    });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, tenantA.userId));
    await db.delete(users).where(eq(users.id, tenantB.userId));
  });

  it('1. Creates a route security policy with rateLimitRpm, enableWaf, and enableSsrf', async () => {
    const res = await request(app)
      .post('/api/control/policies')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .set('X-FortiX-Project-Id', tenantA.projectId)
      .send({
        projectId: tenantA.projectId,
        routeId: tenantA.routeId,
        rateLimitRpm: 45,
        enableWaf: true,
        enableSsrf: true
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.routeId).toBe(tenantA.routeId);
    expect(res.body.rateLimitRpm).toBe(45);
    expect(res.body.enableWaf).toBe(true);
    expect(res.body.enableSsrf).toBe(true);
    expect(res.body.pathPattern).toBe('/v1/payments');
    createdPolicyId = res.body.id;
  });

  it('2. Rejects out-of-range rateLimitRpm values', async () => {
    const res = await request(app)
      .post('/api/control/policies')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .set('X-FortiX-Project-Id', tenantA.projectId)
      .send({
        projectId: tenantA.projectId,
        routeId: tenantA.routeId,
        rateLimitRpm: 0,
        enableWaf: true,
        enableSsrf: false
      });

    expect(res.status).toBe(400);
  });

  it('3. Lists enriched route policies for owner and isolates foreign tenants', async () => {
    const ownerRes = await request(app)
      .get(`/api/control/policies?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantA.token}`)
      .set('X-FortiX-Project-Id', tenantA.projectId);

    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body).toHaveLength(1);
    expect(ownerRes.body[0].pathPattern).toBe('/v1/payments');
    expect(ownerRes.body[0].targetUrl).toBe('http://fortix-demo-api:3001/api/v1/data');

    const foreignRes = await request(app)
      .get(`/api/control/policies?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .set('X-FortiX-Project-Id', tenantA.projectId);

    expect(foreignRes.status).toBe(403);
  });

  it('4. Enforces deep parameter SSRF blocking when enableSsrf=true on the route policy', async () => {
    const res = await request(app)
      .get(`/proxy/${tenantA.routeId}?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`)
      .set('X-API-Key', tenantA.rawApiKey);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('SSRF');
  });

  it('5. Blocks cross-tenant deletion and succeeds on bodyless DELETE for owner', async () => {
    const foreignDel = await request(app)
      .delete(`/api/control/policies/${createdPolicyId}?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .set('X-FortiX-Project-Id', tenantA.projectId);

    expect(foreignDel.status).toBe(403);

    // Bodyless DELETE matching browser fetchWithAuth(..., { method: 'DELETE' })
    const ownerDel = await request(app)
      .delete(`/api/control/policies/${createdPolicyId}?projectId=${tenantA.projectId}`)
      .set('Authorization', `Bearer ${tenantA.token}`)
      .set('X-FortiX-Project-Id', tenantA.projectId);

    expect(ownerDel.status).toBe(200);
    expect(ownerDel.body.success).toBe(true);

    const remaining = await db
      .select()
      .from(securityPolicies)
      .where(eq(securityPolicies.id, createdPolicyId));
    expect(remaining).toHaveLength(0);
  });
});
