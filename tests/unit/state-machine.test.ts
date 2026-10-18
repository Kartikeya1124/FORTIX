import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/db/index.js';
import { workflowRuns, projects, organizations, users, apiRoutes, apiKeys, experiments } from '../../src/db/schema.js';
import {
  transitionWorkflowStatus,
  reconcileAbandonedRuns,
  InvalidStateTransitionError,
  ALLOWED_TRANSITIONS,
} from '../../src/autonomous/stateMachine.js';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';

describe('Durable State Machine & Crash Recovery Reconciliation', () => {
  let testUserId: string;
  let testOrgId: string;
  let testProjectId: string;
  let testRouteId: string;

  beforeEach(async () => {
    await db.delete(workflowRuns);
    testUserId = uuidv4();
    testOrgId = uuidv4();
    testProjectId = uuidv4();
    testRouteId = uuidv4();

    await db.insert(users).values({
      id: testUserId,
      email: `sm-test-${testUserId.slice(0, 8)}@fortix.io`,
      passwordHash: 'dummy',
    });

    await db.insert(organizations).values({
      id: testOrgId,
      name: 'SM Org',
      ownerId: testUserId,
    });

    await db.insert(projects).values({
      id: testProjectId,
      orgId: testOrgId,
      name: 'SM Project',
    });

    await db.insert(apiRoutes).values({
      id: testRouteId,
      projectId: testProjectId,
      pathPattern: '/api/v1/orders',
      targetUrl: 'https://httpbin.org/get',
    });
  });

  it('1. Executes valid state transitions transactionally and appends to timeline', async () => {
    const runId = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    await db.insert(workflowRuns).values({
      id: runId,
      projectId: testProjectId,
      routeId: testRouteId,
      profile: 'security-audit',
      status: 'QUEUED',
      params: {},
      timeline: [{ stage: 'QUEUED', level: 'INFO', message: 'Created', timestamp: new Date().toISOString() }],
      cleanupStatus: 'NOT_REQUIRED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // QUEUED -> RUNNING
    const step1 = await transitionWorkflowStatus(runId, 'RUNNING', {
      timelineMessage: 'Probes initialized',
    });
    expect(step1.transitioned).toBe(true);
    expect(step1.run.status).toBe('RUNNING');

    // RUNNING -> VERIFYING
    const step2 = await transitionWorkflowStatus(runId, 'VERIFYING', {
      timelineMessage: 'Probes complete, analyzing telemetry',
    });
    expect(step2.transitioned).toBe(true);
    expect(step2.run.status).toBe('VERIFYING');

    // VERIFYING -> COMPLETED
    const step3 = await transitionWorkflowStatus(runId, 'COMPLETED', {
      timelineMessage: 'Verification passed',
    });
    expect(step3.transitioned).toBe(true);
    expect(step3.run.status).toBe('COMPLETED');
    expect(step3.run.completedAt).toBeDefined();

    // Verify timeline depth
    const [finalRecord] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect((finalRecord.timeline as any[]).length).toBe(4);
  });

  it('2. Is idempotent when transitioning to the current state', async () => {
    const runId = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    await db.insert(workflowRuns).values({
      id: runId,
      projectId: testProjectId,
      routeId: testRouteId,
      profile: 'resilience-stress',
      status: 'RUNNING',
      params: {},
      timeline: [{ stage: 'RUNNING', level: 'INFO', message: 'Executing', timestamp: new Date().toISOString() }],
      cleanupStatus: 'NOT_REQUIRED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Call transition to RUNNING again
    const result = await transitionWorkflowStatus(runId, 'RUNNING');
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('already_at_target_status');
    expect(result.run.status).toBe('RUNNING');

    // Timeline count remains 1 (no duplicate entries)
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect((stored.timeline as any[]).length).toBe(1);
  });

  it('3. Rejects illegal transitions and protects terminal states', async () => {
    const runId = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    await db.insert(workflowRuns).values({
      id: runId,
      projectId: testProjectId,
      routeId: testRouteId,
      profile: 'failover-recovery',
      status: 'COMPLETED',
      params: {},
      timeline: [],
      cleanupStatus: 'CLEANED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Attempt to transition out of terminal COMPLETED state to RUNNING
    await expect(transitionWorkflowStatus(runId, 'RUNNING')).rejects.toThrow(InvalidStateTransitionError);

    // Attempt to transition out of terminal COMPLETED state to FAILED
    await expect(transitionWorkflowStatus(runId, 'FAILED')).rejects.toThrow(InvalidStateTransitionError);

    // Attempt to transition out of terminal COMPLETED state to CANCELLED
    await expect(transitionWorkflowStatus(runId, 'CANCELLED')).rejects.toThrow(InvalidStateTransitionError);
  });

  it('4. Reconciles abandoned in-flight runs into RECOVERY_REQUIRED after simulated worker crash', async () => {
    const abandonedRun1 = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const abandonedRun2 = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const completedRun = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Run 1: left in RUNNING when worker crashed
    await db.insert(workflowRuns).values({
      id: abandonedRun1,
      projectId: testProjectId,
      routeId: testRouteId,
      profile: 'full-verification',
      status: 'RUNNING',
      params: {},
      timeline: [],
      cleanupStatus: 'NOT_REQUIRED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Insert active experiment that should be cleaned up
    const expId = uuidv4();
    await db.insert(experiments).values({
      id: expId,
      routeId: testRouteId,
      type: 'error_5xx',
      status: 'RUNNING',
      config: {},
      startedAt: new Date(),
    });

    // Run 2: left in VERIFYING when worker crashed
    await db.insert(workflowRuns).values({
      id: abandonedRun2,
      projectId: testProjectId,
      routeId: testRouteId,
      profile: 'security-audit',
      status: 'VERIFYING',
      params: {},
      timeline: [],
      cleanupStatus: 'NOT_REQUIRED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Run 3: already COMPLETED (should not be touched)
    await db.insert(workflowRuns).values({
      id: completedRun,
      projectId: testProjectId,
      routeId: testRouteId,
      profile: 'resilience-stress',
      status: 'COMPLETED',
      params: {},
      timeline: [],
      cleanupStatus: 'CLEANED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Run reconciliation
    const result = await reconcileAbandonedRuns();

    expect(result.reconciledCount).toBe(2);
    expect(result.runIds).toContain(abandonedRun1);
    expect(result.runIds).toContain(abandonedRun2);
    expect(result.runIds).not.toContain(completedRun);

    // Verify Run 1 updated
    const [rec1] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, abandonedRun1));
    expect(rec1.status).toBe('RECOVERY_REQUIRED');
    expect(rec1.cleanupStatus).toBe('CLEANED');

    // Verify lingering experiment was cleaned up
    const [exp] = await db.select().from(experiments).where(eq(experiments.id, expId));
    expect(exp.status).toBe('COMPLETED');
  });
});
