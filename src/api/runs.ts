import express from 'express';
import { db } from '../db/index.js';
import { workflowRuns, apiRoutes, projects, organizations } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { requireProjectOwnership } from './projects.js';
import { createAutonomousWorkflowRun, WorkflowProfile } from '../autonomous/engine.js';
import { z } from 'zod';
import { artifactStorage } from '../storage/index.js';

const router = express.Router();

const createRunSchema = z.object({
  projectId: z.string().min(1),
  routeId: z.string().min(1),
  profile: z.enum(['security-audit', 'resilience-stress', 'failover-recovery', 'full-verification']),
  customConfig: z
    .object({
      burstRequests: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(500).max(30000).optional(),
      faultDurationMs: z.number().int().min(1000).max(10000).optional(),
    })
    .optional(),
});

// POST /api/control/runs - Launch autonomous workflow run
router.post('/', requireProjectOwnership, async (req: any, res) => {
  try {
    const validated = createRunSchema.parse(req.body);
    const userId = req.user.id;

    const run = await createAutonomousWorkflowRun({
      userId,
      projectId: validated.projectId,
      routeId: validated.routeId,
      profile: validated.profile as WorkflowProfile,
      customConfig: validated.customConfig,
    });

    res.status(202).json({
      message: 'Autonomous workflow run initiated',
      runId: run.id,
      status: run.status,
      profile: run.profile,
      timeline: run.timeline,
      createdAt: run.createdAt,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation Error', details: error.issues });
    }
    console.error('[Runs API] Failed to start run:', error);
    res.status(400).json({ error: error.message || 'Failed to start autonomous run' });
  }
});

// GET /api/control/runs - List all runs for project
router.get('/', requireProjectOwnership, async (req, res) => {
  const projectId = req.query.projectId as string;
  try {
    const list = await db
      .select({
        id: workflowRuns.id,
        projectId: workflowRuns.projectId,
        routeId: workflowRuns.routeId,
        profile: workflowRuns.profile,
        status: workflowRuns.status,
        params: workflowRuns.params,
        cleanupStatus: workflowRuns.cleanupStatus,
        deterministicVerdict: workflowRuns.deterministicVerdict,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
        createdAt: workflowRuns.createdAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.projectId, projectId))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(50);

    res.json(list);
  } catch (error) {
    console.error('[Runs API] Failed to list runs:', error);
    res.status(500).json({ error: 'Failed to retrieve workflow runs' });
  }
});

// GET /api/control/runs/:runId - Detailed status, timeline, deterministic results & AI analysis
router.get('/:runId', requireProjectOwnership, async (req, res) => {
  const runId = String(req.params.runId);
  const projectId = req.query.projectId as string;

  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.projectId, projectId)))
      .limit(1);

    if (!run) {
      return res.status(404).json({ error: 'Workflow run not found' });
    }

    res.json(run);
  } catch (error) {
    console.error('[Runs API] Failed to retrieve run:', error);
    res.status(500).json({ error: 'Failed to retrieve run details' });
  }
});

// POST /api/control/runs/:runId/cancel - Safely cancel an in-progress or queued run
router.post('/:runId/cancel', requireProjectOwnership, async (req, res) => {
  const runId = String(req.params.runId);
  const projectId = req.body.projectId || (req.query.projectId as string);

  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.projectId, projectId)))
      .limit(1);

    if (!run) {
      return res.status(404).json({ error: 'Workflow run not found' });
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      return res.status(400).json({ error: `Run is already in terminal state ${run.status}` });
    }

    const [updated] = await db
      .update(workflowRuns)
      .set({
        status: 'CANCELLED',
        cleanupStatus: 'CLEANED',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId))
      .returning();

    res.json({ message: 'Run successfully cancelled and resources cleaned up', run: updated });
  } catch (error) {
    console.error('[Runs API] Failed to cancel run:', error);
    res.status(500).json({ error: 'Failed to cancel workflow run' });
  }
});

// GET /api/control/runs/:runId/report - Download evidence report (JSON or redirect to PDF artifact)
router.get('/:runId/report', requireProjectOwnership, async (req, res) => {
  const runId = String(req.params.runId);
  const projectId = req.query.projectId as string;
  const format = (req.query.format as string) || 'json';

  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.projectId, projectId)))
      .limit(1);

    if (!run) {
      return res.status(404).json({ error: 'Workflow run not found' });
    }

    if (format === 'pdf') {
      const artifactId = (run.evidenceSummary as any)?.artifactId;
      if (!artifactId) {
        return res.status(404).json({ error: 'PDF report artifact not found for this run' });
      }

      const artifact = await artifactStorage.get(artifactId, projectId);
      if (!artifact) {
        return res.status(404).json({ error: 'Report artifact missing from storage' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=FortiX-Run-${runId}.pdf`);
      return res.send(artifact.data);
    }

    // Default: Full evidence JSON report
    res.json({
      runId: run.id,
      projectId: run.projectId,
      routeId: run.routeId,
      profile: run.profile,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      deterministicVerdict: run.deterministicVerdict,
      aiAnalysis: run.aiAnalysis,
      evidenceSummary: run.evidenceSummary,
      timeline: run.timeline,
      cleanupStatus: run.cleanupStatus,
    });
  } catch (error) {
    console.error('[Runs API] Failed to fetch report:', error);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

export const workflowRunsRouter = router;
