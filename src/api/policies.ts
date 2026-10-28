import { z } from 'zod';
import express from 'express';
import { db } from '../db/index.js';
import { securityPolicies, apiRoutes } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { requireProjectOwnership } from './projects.js';

const router = express.Router();

function resolveProjectId(req: express.Request): string {
  return (
    ((req as any).project?.id as string) ||
    (req.query.projectId as string) ||
    (req.body?.projectId as string) ||
    ''
  );
}

const policyPayloadSchema = z.object({
  routeId: z.string().min(1),
  rateLimitRpm: z.number().int().min(1).max(100000).nullable().optional(),
  enableWaf: z.boolean().default(false),
  enableSsrf: z.boolean().default(false)
});

router.get('/', requireProjectOwnership, async (req, res) => {
  const projectId = resolveProjectId(req);
  try {
    const list = await db
      .select({
        id: securityPolicies.id,
        routeId: securityPolicies.routeId,
        pathPattern: apiRoutes.pathPattern,
        targetUrl: apiRoutes.targetUrl,
        rateLimitRpm: securityPolicies.rateLimitRpm,
        enableWaf: securityPolicies.enableWaf,
        enableSsrf: securityPolicies.enableSsrf,
        createdAt: securityPolicies.createdAt
      })
      .from(securityPolicies)
      .innerJoin(apiRoutes, eq(securityPolicies.routeId, apiRoutes.id))
      .where(eq(apiRoutes.projectId, projectId))
      .orderBy(desc(securityPolicies.createdAt));

    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch security policies' });
  }
});

router.post('/', requireProjectOwnership, async (req, res) => {
  const projectId = resolveProjectId(req);
  try {
    const { routeId, rateLimitRpm, enableWaf, enableSsrf } = policyPayloadSchema.parse(req.body);

    // Ensure route belongs to active project
    const [route] = await db
      .select()
      .from(apiRoutes)
      .where(and(eq(apiRoutes.id, routeId), eq(apiRoutes.projectId, projectId)))
      .limit(1);

    if (!route) {
      return res.status(404).json({ error: 'Route not found in this project' });
    }

    // Replace existing policy for this route atomically
    await db.delete(securityPolicies).where(eq(securityPolicies.routeId, routeId));

    const [newPolicy] = await db
      .insert(securityPolicies)
      .values({
        id: uuidv4(),
        routeId,
        rateLimitRpm: typeof rateLimitRpm === 'number' ? rateLimitRpm : null,
        enableWaf,
        enableSsrf
      })
      .returning();

    res.status(201).json({
      ...newPolicy,
      pathPattern: route.pathPattern,
      targetUrl: route.targetUrl
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid policy configuration', issues: error.issues });
    }
    res.status(500).json({ error: 'Failed to save policy' });
  }
});

router.delete('/:id', requireProjectOwnership, async (req, res) => {
  const { id } = req.params;
  const projectId = resolveProjectId(req);
  try {
    // Verify ownership via join against apiRoutes.projectId
    const [policy] = await db
      .select({ id: securityPolicies.id })
      .from(securityPolicies)
      .innerJoin(apiRoutes, eq(securityPolicies.routeId, apiRoutes.id))
      .where(and(eq(securityPolicies.id, id as string), eq(apiRoutes.projectId, projectId)))
      .limit(1);

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    await db.delete(securityPolicies).where(eq(securityPolicies.id, id as string));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete policy' });
  }
});

export const policiesRouter = router;
