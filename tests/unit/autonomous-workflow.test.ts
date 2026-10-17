import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { db } from '../../src/db/index.js';
import { workflowRuns, apiRoutes, projects, organizations, users, apiKeys } from '../../src/db/schema.js';
import { workflowRunsRouter } from '../../src/api/runs.js';
import { createAutonomousWorkflowRun } from '../../src/autonomous/engine.js';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';

describe('Autonomous Workflow Execution & Lifecycle Engine', () => {
  let app: express.Express;
  let testUserId: string;
  let testOrgId: string;
  let testProjectId: string;
  let safeRouteId: string;
  let unsafeRouteId: string;

  beforeEach(async () => {
    testUserId = uuidv4();
    testOrgId = uuidv4();
    testProjectId = uuidv4();
    safeRouteId = uuidv4();
    unsafeRouteId = uuidv4();

    await db.insert(users).values({
      id: testUserId,
      email: `auto-test-${testUserId.slice(0, 8)}@fortix.io`,
      passwordHash: 'dummy-hash',
    });

    await db.insert(organizations).values({
      id: testOrgId,
      name: 'Auto Org',
      ownerId: testUserId,
    });

    await db.insert(projects).values({
      id: testProjectId,
      orgId: testOrgId,
      name: 'Autonomous Project',
      environment: 'development',
    });

    // Safe public route
    await db.insert(apiRoutes).values({
      id: safeRouteId,
      projectId: testProjectId,
      pathPattern: '/api/v1/billing',
      targetUrl: 'https://httpbin.org/status/200',
    });

    // Unsafe SSRF cloud metadata route
    await db.insert(apiRoutes).values({
      id: unsafeRouteId,
      projectId: testProjectId,
      pathPattern: '/api/v1/metadata',
      targetUrl: 'http://169.254.169.254/latest/meta-data',
    });

    app = express();
    app.use(express.json());

    // Mock authenticated user
    app.use((req: any, _res, next) => {
      req.user = { id: testUserId, email: 'test@fortix.io' };
      next();
    });

    app.use('/api/control/runs', workflowRunsRouter);
  });

  it('1. Rejects creation of runs targeting SSRF-restricted endpoints', async () => {
    const res = await request(app)
      .post('/api/control/runs')
      .send({
        projectId: testProjectId,
        routeId: unsafeRouteId,
        profile: 'security-audit',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SSRF/i);
  });

  it('2. Initiates autonomous run, assigns unique run ID, and transitions through lifecycle states', async () => {
    const res = await request(app)
      .post('/api/control/runs')
      .send({
        projectId: testProjectId,
        routeId: safeRouteId,
        profile: 'resilience-stress',
      });

    expect(res.status).toBe(202);
    expect(res.body.runId).toBeDefined();
    expect(res.body.runId.startsWith('run_')).toBe(true);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.timeline.length).toBeGreaterThan(0);

    // Verify persisted in database
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, res.body.runId));
    expect(stored).toBeDefined();
    expect(stored.projectId).toBe(testProjectId);
    expect(stored.profile).toBe('resilience-stress');
  });

  it('3. Safely cancels an in-progress or queued run and enforces cleanup', async () => {
    const createRes = await request(app)
      .post('/api/control/runs')
      .send({
        projectId: testProjectId,
        routeId: safeRouteId,
        profile: 'failover-recovery',
      });

    const runId = createRes.body.runId;

    // Cancel run
    const cancelRes = await request(app)
      .post(`/api/control/runs/${runId}/cancel`)
      .send({ projectId: testProjectId });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.run.status).toBe('CANCELLED');
    expect(cancelRes.body.run.cleanupStatus).toBe('CLEANED');

    // Second cancellation is rejected idempotently
    const duplicateCancel = await request(app)
      .post(`/api/control/runs/${runId}/cancel`)
      .send({ projectId: testProjectId });

    expect(duplicateCancel.status).toBe(400);
    expect(duplicateCancel.body.error).toMatch(/terminal state/i);
  });

  it('4. Provides downloadable evidence reports with deterministic verdicts', async () => {
    // Insert a completed run
    const runId = `run_test_${uuidv4().slice(0, 8)}`;
    await db.insert(workflowRuns).values({
      id: runId,
      projectId: testProjectId,
      routeId: safeRouteId,
      profile: 'full-verification',
      status: 'COMPLETED',
      params: { targetUrl: 'https://httpbin.org/status/200' },
      timeline: [{ stage: 'COMPLETED', level: 'SUCCESS', message: 'All done', timestamp: new Date().toISOString() }],
      deterministicVerdict: {
        passed: true,
        score: 95,
        checks: [{ name: 'Latency SLA', category: 'SLA', passed: true, observed: '45ms', threshold: '2500ms', evidenceRef: 'ref_1' }],
        latencyPercentiles: { p50: 25, p90: 40, p95: 45, p99: 60 },
        errorRate: 0,
        totalDurationMs: 1200,
      },
      evidenceSummary: { totalRequests: 50, passedRequests: 50, blockedRequests: 0, errorRequests: 0, securityEventsCount: 0 },
      cleanupStatus: 'CLEANED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const reportRes = await request(app)
      .get(`/api/control/runs/${runId}/report?projectId=${testProjectId}&format=json`);

    expect(reportRes.status).toBe(200);
    expect(reportRes.body.runId).toBe(runId);
    expect(reportRes.body.deterministicVerdict.passed).toBe(true);
    expect(reportRes.body.deterministicVerdict.score).toBe(95);
    expect(reportRes.body.evidenceSummary.totalRequests).toBe(50);
  });
});
