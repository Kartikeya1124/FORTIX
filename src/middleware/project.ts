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

// Middleware to ensure user owns project before allowing nested operations
export const requireProjectOwnership = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const userId = req.user!.id;
  // Check headers first (from frontend active project context), then params/body/query
  let projectId = (req.headers['x-fortix-project-id'] as string) || req.params.projectId || req.body?.projectId || req.query.projectId;
  
  try {
    const org = await getDefaultOrg(userId);
    let project;
    
    if (projectId && projectId !== 'undefined' && projectId !== 'null' && typeof projectId === 'string') {
      const [foundProject] = await db.select().from(projects).where(
        eq(projects.id, projectId.trim())
      ).limit(1);
      
      if (foundProject) {
        if (foundProject.orgId !== org.id) {
          return res.status(403).json({ error: 'Forbidden: You do not own this project' });
        }
        project = foundProject;
      }
    }
    
    if (!project) {
      let [defaultProject] = await db.select().from(projects).where(eq(projects.orgId, org.id)).limit(1);
      if (!defaultProject) {
        [defaultProject] = await db.insert(projects).values({
          id: uuidv4(),
          name: 'Production Gateway',
          orgId: org.id,
          environment: 'production'
        }).returning();
      }
      project = defaultProject;
    }
    
    // Inject normalized project ID into query and body for downstream controllers
    if (req.method === 'GET' || req.method === 'DELETE') {
      req.query.projectId = project.id;
    } else if (req.body && typeof req.body === 'object') {
      req.body.projectId = project.id;
    }
    
    (req as any).project = project;
    next();
  } catch (error) {
    console.error('[Projects Middleware] Ownership check error:', error);
    return res.status(500).json({ error: 'Failed to verify project ownership' });
  }
};
