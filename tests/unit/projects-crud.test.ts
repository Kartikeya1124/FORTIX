import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupApiRoutes } from '../../src/api/index.js';
import { db } from '../../src/db/index.js';
import { users, organizations, projects, projectSettings, apiRoutes, apiKeys } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

const app = express();
app.use(express.json());
setupApiRoutes(app);

describe('API Projects & Policy Governance - CRUD & Switching', () => {
  const testUserId = uuidv4();
  const testOrgId = uuidv4();
  const jwtSecret = process.env.JWT_SECRET || 'dev_secret_key';
  const authToken = jwt.sign({ id: testUserId, email: 'project-test@fortix.io', role: 'ADMIN' }, jwtSecret);

  let initialProjectId: string;

  beforeAll(async () => {
    // Seed initial user and organization with one initial project
    await db.insert(users).values({
      id: testUserId,
      email: 'project-test@fortix.io',
      passwordHash: 'hashed_pw',
      role: 'ADMIN'
    });

    await db.insert(organizations).values({
      id: testOrgId,
      name: 'Test Project Org',
      ownerId: testUserId
    });

    initialProjectId = uuidv4();
    await db.insert(projects).values({
      id: initialProjectId,
      name: 'Default Gateway',
      orgId: testOrgId,
      environment: 'production'
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(users).where(eq(users.id, testUserId));
  });

  it('1. Lists existing projects enriched with metadata, routes, keys, and policy settings', async () => {
    const res = await request(app)
      .get('/api/control/projects')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    const proj = res.body.find((p: any) => p.id === initialProjectId);
    expect(proj).toBeDefined();
    expect(proj.name).toBe('Default Gateway');
    expect(proj.routeCount).toBeDefined();
    expect(proj.keyCount).toBeDefined();
    expect(proj.experimentCount).toBeDefined();
  });

  let createdProjectId: string;

  it('2. Creates a new API project with strict security policy preset', async () => {
    const res = await request(app)
      .post('/api/control/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Payments Secure Gateway',
        environment: 'production',
        policyPreset: 'strict'
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Payments Secure Gateway');
    expect(res.body.environment).toBe('production');
    createdProjectId = res.body.id;

    // Verify dedicated projectSettings were initialized with strict values
    const [settings] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, createdProjectId));
    expect(settings).toBeDefined();
    expect((settings.rateLimitConfig as any).defaultRpm).toBe(30);
    expect((settings.rateLimitConfig as any).failureMode).toBe('FAIL_CLOSED');
    expect((settings.gatewayConfig as any).upstreamTimeoutMs).toBe(3000);
  });

  it('3. Creates a permissive sandbox project with high throughput preset', async () => {
    const res = await request(app)
      .post('/api/control/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Developer Sandbox Gateway',
        environment: 'development',
        policyPreset: 'permissive'
      });

    expect(res.status).toBe(201);
    const sandboxId = res.body.id;

    const [settings] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, sandboxId));
    expect(settings).toBeDefined();
    expect((settings.rateLimitConfig as any).defaultRpm).toBe(300);
    expect((settings.rateLimitConfig as any).failureMode).toBe('FAIL_OPEN');
  });

  it('4. Rejects project creation with invalid or empty name', async () => {
    const res = await request(app)
      .post('/api/control/projects')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: ' ',
        environment: 'development'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('5. Retrieves single project details and policy settings', async () => {
    const res = await request(app)
      .get(`/api/control/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdProjectId);
    expect(res.body.name).toBe('Payments Secure Gateway');
    expect(res.body.settings).toBeDefined();
  });

  it('6. Updates and renames a project', async () => {
    const res = await request(app)
      .patch(`/api/control/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Payments Global Hub',
        environment: 'staging'
      });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Payments Global Hub');
    expect(res.body.environment).toBe('staging');
  });

  it('7. Applies a calibrated policy preset to an existing project', async () => {
    const res = await request(app)
      .post(`/api/control/projects/${createdProjectId}/policy-preset`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ preset: 'balanced' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('balanced');
    expect(res.body.settings.rateLimitConfig.defaultRpm).toBe(60);
    expect(res.body.settings.gatewayConfig.upstreamTimeoutMs).toBe(5000);
  });

  it('8. Updates unique customized configuration policies for a project', async () => {
    const res = await request(app)
      .put(`/api/control/projects/${createdProjectId}/policies`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        rateLimitConfig: {
          defaultRpm: 120,
          burstMultiplier: 3,
          failureMode: 'LOCAL_LIMIT',
          keyStrategy: 'IP_AND_KEY'
        },
        gatewayConfig: {
          requestTimeoutMs: 8000,
          upstreamTimeoutMs: 4000,
          maxBodyBytes: 20971520,
          enableRequestId: true,
          corsAllowedOrigins: ['*']
        }
      });

    expect(res.status).toBe(200);
    expect(res.body.settings.rateLimitConfig.defaultRpm).toBe(120);
    expect(res.body.settings.rateLimitConfig.failureMode).toBe('LOCAL_LIMIT');
    expect(res.body.settings.gatewayConfig.upstreamTimeoutMs).toBe(4000);
  });

  it('9. Deletes project and cascades associated resources', async () => {
    // Add dummy route to created project
    const routeId = uuidv4();
    await db.insert(apiRoutes).values({
      id: routeId,
      projectId: createdProjectId,
      pathPattern: '/api/v1/payments',
      targetUrl: 'https://httpbin.org/get'
    });

    const res = await request(app)
      .delete(`/api/control/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.nextActiveProjectId).toBeDefined();

    // Verify project and route were deleted
    const [foundProj] = await db.select().from(projects).where(eq(projects.id, createdProjectId));
    expect(foundProj).toBeUndefined();

    const [foundRoute] = await db.select().from(apiRoutes).where(eq(apiRoutes.id, routeId));
    expect(foundRoute).toBeUndefined();
  });

  it('10. Enforces safety guardrail: prevents deleting the only remaining project', async () => {
    // Delete all projects except the initial one
    const remaining = await db.select().from(projects).where(eq(projects.orgId, testOrgId));
    for (const p of remaining) {
      if (p.id !== initialProjectId) {
        await db.delete(projects).where(eq(projects.id, p.id));
      }
    }

    // Now try to delete initialProjectId
    const res = await request(app)
      .delete(`/api/control/projects/${initialProjectId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot delete the only remaining project');
  });
});
