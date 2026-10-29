import express, { Request, Response } from 'express';
import {
  listDlqJobs,
  getDlqJob,
  retryDlqJob,
  retryAllDlqJobs,
  discardDlqJob,
  purgeAllDlqJobs,
  getQueueStats,
  isDlqJobVisibleToTenant,
} from '../lib/dlq.js';
import { db } from '../db/index.js';
import { organizations, projects } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { AuthRequest } from '../middleware/auth.js';

const router = express.Router();

const querySchema = z.object({
  queueName: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

async function resolveCallerProjects(req: Request): Promise<Set<string>> {
  const authReq = req as AuthRequest;
  const userId = authReq.user?.id;
  if (!userId) return new Set();

  const userOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.ownerId, userId));

  if (userOrgs.length === 0) return new Set();

  const orgIds = userOrgs.map((o) => o.id);
  const ownedProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.orgId, orgIds));

  return new Set(ownedProjects.map((p) => p.id));
}

function extractExplicitProjectFilter(req: Request): string | undefined {
  const queryProj = typeof req.query.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : undefined;
  const headerProj =
    typeof req.headers['x-fortix-project-id'] === 'string' && req.headers['x-fortix-project-id'].trim()
      ? req.headers['x-fortix-project-id'].trim()
      : undefined;
  return queryProj || headerProj;
}

/**
 * GET /api/control/dlq/stats
 * Aggregate queue health and DLQ statistics scoped to caller's projects
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    const stats = await getQueueStats(allowedProjectIds, explicitProjectId);
    res.json(stats);
  } catch (err: any) {
    logger.error({ err }, '[DLQ API] Failed to fetch queue stats');
    res.status(500).json({ error: 'Failed to retrieve queue statistics' });
  }
});

/**
 * GET /api/control/dlq
 * List dead-letter jobs scoped to caller's projects
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const query = querySchema.parse(req.query);
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = query.projectId || extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    const result = await listDlqJobs({
      ...query,
      projectId: explicitProjectId,
      allowedProjectIds,
    });
    res.json(result);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation Error', details: err.issues });
    }
    logger.error({ err }, '[DLQ API] Failed to list DLQ jobs');
    res.status(500).json({ error: 'Failed to list DLQ jobs' });
  }
});

/**
 * POST /api/control/dlq/retry-all
 * Bulk retry dead-letter jobs owned by the caller
 */
router.post('/retry-all', async (req: Request, res: Response) => {
  try {
    const queueName = req.query.queueName as string | undefined;
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    const result = await retryAllDlqJobs(queueName, allowedProjectIds, explicitProjectId);
    res.status(200).json(result);
  } catch (err: any) {
    logger.error({ err }, '[DLQ API] Failed to bulk retry DLQ jobs');
    res.status(500).json({ error: 'Failed to bulk retry DLQ jobs' });
  }
});

/**
 * DELETE /api/control/dlq/purge-all
 * Bulk purge dead-letter jobs owned by the caller
 */
router.delete('/purge-all', async (req: Request, res: Response) => {
  try {
    const queueName = req.query.queueName as string | undefined;
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    const result = await purgeAllDlqJobs(queueName, allowedProjectIds, explicitProjectId);
    res.status(200).json(result);
  } catch (err: any) {
    logger.error({ err }, '[DLQ API] Failed to purge DLQ jobs');
    res.status(500).json({ error: 'Failed to purge DLQ jobs' });
  }
});

/**
 * GET /api/control/dlq/:jobId
 * Retrieve single dead-letter job with tenant ownership verification
 */
router.get('/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const job = await getDlqJob(jobId);
    if (!job) {
      return res.status(404).json({ error: `DLQ Job with ID '${jobId}' not found` });
    }
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    if (!(await isDlqJobVisibleToTenant(job, allowedProjectIds, explicitProjectId))) {
      return res.status(403).json({ error: 'Forbidden: DLQ job belongs to another project' });
    }
    res.json(job);
  } catch (err: any) {
    logger.error({ err, jobId: String(req.params.jobId) }, '[DLQ API] Failed to get DLQ job');
    res.status(500).json({ error: 'Failed to retrieve DLQ job' });
  }
});

/**
 * POST /api/control/dlq/:jobId/retry
 * Replay/retry an individual failed job with tenant ownership verification
 */
router.post('/:jobId/retry', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const job = await getDlqJob(jobId);
    if (!job) {
      return res.status(404).json({ error: `DLQ Job ${jobId} not found` });
    }
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    if (!(await isDlqJobVisibleToTenant(job, allowedProjectIds, explicitProjectId))) {
      return res.status(403).json({ error: 'Forbidden: DLQ job belongs to another project' });
    }
    const result = await retryDlqJob(jobId);
    if (!result.success) {
      return res.status(404).json({ error: result.message });
    }
    res.status(200).json(result);
  } catch (err: any) {
    logger.error({ err, jobId: String(req.params.jobId) }, '[DLQ API] Failed to retry DLQ job');
    res.status(500).json({ error: 'Failed to retry DLQ job' });
  }
});

/**
 * DELETE /api/control/dlq/:jobId
 * Discard / delete an individual failed job with tenant ownership verification
 */
router.delete('/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const job = await getDlqJob(jobId);
    if (!job) {
      return res.status(404).json({ error: `DLQ Job ${jobId} not found` });
    }
    const allowedProjectIds = await resolveCallerProjects(req);
    const explicitProjectId = extractExplicitProjectFilter(req);
    if (explicitProjectId && !allowedProjectIds.has(explicitProjectId)) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
    if (!(await isDlqJobVisibleToTenant(job, allowedProjectIds, explicitProjectId))) {
      return res.status(403).json({ error: 'Forbidden: DLQ job belongs to another project' });
    }
    const result = await discardDlqJob(jobId);
    if (!result.success) {
      return res.status(404).json({ error: result.message });
    }
    res.status(200).json(result);
  } catch (err: any) {
    logger.error({ err, jobId: String(req.params.jobId) }, '[DLQ API] Failed to discard DLQ job');
    res.status(500).json({ error: 'Failed to discard DLQ job' });
  }
});

export const dlqRouter = router;
