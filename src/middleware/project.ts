import express from 'express';
import { db } from '../db/index.js';
import { projects, organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from './auth.js';

// Helper to get or create a default organization for a user
export async function getDefaultOrg(userId: string) {
  let [org] = await db.select().from(organizations).where(eq(organizations.ownerId, userId)).limit(1);
  if (!org) {
    [org] = await db.insert(organizations).values({
      id: uuidv4(),
      name: 'Default Organization',
      ownerId: userId
    }).returning();
  }
  return org;
}

function normalizeCandidateProjectId(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return undefined;
  return trimmed;
}

// Middleware to ensure user owns project before allowing nested operations
export const requireProjectOwnership = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const userId = req.user!.id;

  const paramId = normalizeCandidateProjectId(req.params?.projectId);
  const bodyId = normalizeCandidateProjectId(req.body?.projectId);
  const queryId = normalizeCandidateProjectId(req.query?.projectId);
  const headerId = normalizeCandidateProjectId(req.headers['x-fortix-project-id']);

  try {
    const org = await getDefaultOrg(userId);
    const resolvedById = new Map<string, typeof projects.$inferSelect>();

    const allCandidates = Array.from(
      new Set([paramId, bodyId, queryId, headerId].filter((id): id is string => Boolean(id)))
    );

    // 1. Validate EVERY supplied project identifier so header cannot mask a cross-tenant param/body/query target
    for (const candidateId of allCandidates) {
      const [found] = await db.select().from(projects).where(eq(projects.id, candidateId)).limit(1);
      if (found) {
        if (found.orgId !== org.id) {
          return res.status(403).json({ error: 'Forbidden: You do not own this project' });
        }
        resolvedById.set(candidateId, found);
      }
    }

    // 2. Explicit route/payload identifiers take precedence over ambient x-fortix-project-id header
    const explicitId = paramId || bodyId || queryId;
    let project: typeof projects.$inferSelect | undefined;

    if (explicitId) {
      project = resolvedById.get(explicitId);
      if (!project) {
        // Explicit projectId does not belong to caller's organization (prevents BOLA & UUID enumeration)
        return res.status(403).json({ error: 'Forbidden: You do not own this project' });
      }
      // Also reject conflicting explicit identifiers within the same request (e.g. paramId !== bodyId)
      if (paramId && bodyId && paramId !== bodyId) {
        return res.status(400).json({ error: 'Conflicting projectId in route parameter and request body' });
      }
      if (paramId && queryId && paramId !== queryId) {
        return res.status(400).json({ error: 'Conflicting projectId in route parameter and query string' });
      }
    } else if (headerId) {
      project = resolvedById.get(headerId);
    }

    // 3. Only fall back to default project when no explicit projectId was requested (e.g. initial load / stale local header)
    if (!project) {
      let [defaultProject] = await db.select().from(projects).where(eq(projects.orgId, org.id)).limit(1);
      if (!defaultProject) {
        [defaultProject] = await db
          .insert(projects)
          .values({
            id: uuidv4(),
            name: 'Production Gateway',
            orgId: org.id,
            environment: 'production',
          })
          .returning();
      }
      project = defaultProject;
    }

    // 4. Normalize all downstream accessors to the verified project ID
    if (req.params && typeof req.params === 'object' && 'projectId' in req.params) {
      req.params.projectId = project.id;
    }
    req.query.projectId = project.id;
    if (req.body && typeof req.body === 'object') {
      req.body.projectId = project.id;
    }

    (req as any).project = project;
    next();
  } catch (error) {
    console.error('[Projects Middleware] Ownership check error:', error);
    return res.status(500).json({ error: 'Failed to verify project ownership' });
  }
};
