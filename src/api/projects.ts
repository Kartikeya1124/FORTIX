import { z } from 'zod';
import express from 'express';
import { db } from '../db/index.js';
import { projects, organizations, apiRoutes, apiKeys, experiments, projectSettings, auditLogs, securityPolicies, metricLogs, securityEvents } from '../db/schema.js';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../middleware/auth.js';

const router = express.Router();

import { getDefaultOrg, requireProjectOwnership } from '../middleware/project.js';
export { getDefaultOrg, requireProjectOwnership };
import { invalidateSettingsCache, defaultSettings, gatewayConfigSchema, securityConfigSchema, rateLimitConfigSchema, experimentConfigSchema } from './settings.js';

// GET /api/control/projects - List all projects with enriched metadata
router.get('/', async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  try {
    const org = await getDefaultOrg(userId);
    const list = await db.select().from(projects).where(eq(projects.orgId, org.id));

    // Enrich with route and key counts for the project management UI
    const enriched = await Promise.all(
      list.map(async (p) => {
        const routes = await db.select({ id: apiRoutes.id }).from(apiRoutes).where(eq(apiRoutes.projectId, p.id));
        const keys = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.projectId, p.id));
        const routeIds = routes.map(r => r.id);
        const exps = routeIds.length > 0 
          ? await db.select({ id: experiments.id }).from(experiments).where(inArray(experiments.routeId, routeIds))
          : [];
        const [settings] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, p.id)).limit(1);

        return {
          ...p,
          routeCount: routes.length,
          keyCount: keys.length,
          experimentCount: exps.length,
          version: settings?.version || 1,
          hasCustomSettings: !!settings,
          settings: settings || null
        };
      })
    );

    res.json(enriched);
  } catch (error) {
    console.error('[Projects API] Failed to fetch projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /api/control/projects/:projectId - Get single project details
router.get('/:projectId', async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const projectId = req.params.projectId as string;
  try {
    const org = await getDefaultOrg(userId);
    const [project] = await db.select().from(projects).where(
      and(eq(projects.id, projectId), eq(projects.orgId, org.id))
    ).limit(1);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const routes = await db.select({ id: apiRoutes.id }).from(apiRoutes).where(eq(apiRoutes.projectId, project.id));
    const keys = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.projectId, project.id));
    const [settings] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, project.id)).limit(1);

    res.json({
      ...project,
      routeCount: routes.length,
      keyCount: keys.length,
      settings: settings || null
    });
  } catch (error) {
    console.error('[Projects API] Failed to fetch project details:', error);
    res.status(500).json({ error: 'Failed to fetch project details' });
  }
});

// Schema for creating projects with optional initial policy presets
const createProjectSchema = z.object({
  name: z.string().trim().min(2, 'Project name must be at least 2 characters').max(64),
  environment: z.enum(['development', 'staging', 'production']).default('development'),
  policyPreset: z.enum(['strict', 'balanced', 'permissive']).optional().default('balanced'),
  description: z.string().max(255).optional()
});

// POST /api/control/projects - Create a new project and initialize unique policy configs
router.post('/', async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  try {
    const { name, environment, policyPreset } = createProjectSchema.parse(req.body);
    const org = await getDefaultOrg(userId);

    const newProjectId = uuidv4();
    const [newProject] = await db.insert(projects).values({
      id: newProjectId,
      name,
      orgId: org.id,
      environment
    }).returning();

    // Customize initial project settings based on chosen policy preset
    let rateLimitRpm = 60;
    let upstreamTimeout = 5000;
    let threatDetect = true;
    let failureMode: 'FAIL_CLOSED' | 'FAIL_OPEN' = 'FAIL_CLOSED';

    if (policyPreset === 'strict' || environment === 'production') {
      rateLimitRpm = 30;
      upstreamTimeout = 3000;
      threatDetect = true;
      failureMode = 'FAIL_CLOSED';
    } else if (policyPreset === 'permissive') {
      rateLimitRpm = 300;
      upstreamTimeout = 10000;
      threatDetect = false;
      failureMode = 'FAIL_OPEN';
    }

    const initialGateway = {
      ...defaultSettings.gatewayConfig,
      upstreamTimeoutMs: upstreamTimeout,
      requestTimeoutMs: upstreamTimeout
    };

    const initialSecurity = {
      ...defaultSettings.securityConfig,
      threatDetection: threatDetect,
      ssrfProtection: true
    };

    const initialRateLimit = {
      ...defaultSettings.rateLimitConfig,
      defaultRpm: rateLimitRpm,
      failureMode
    };

    // Initialize dedicated projectSettings row
    await db.insert(projectSettings).values({
      id: uuidv4(),
      projectId: newProjectId,
      version: 1,
      gatewayConfig: initialGateway,
      securityConfig: initialSecurity,
      rateLimitConfig: initialRateLimit,
      experimentConfig: defaultSettings.experimentConfig,
      telemetryConfig: defaultSettings.telemetryConfig,
      updatedBy: userId
    }).onConflictDoNothing();

    res.status(201).json({
      ...newProject,
      routeCount: 0,
      keyCount: 0,
      experimentCount: 0
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', issues: error.issues });
    }
    console.error('[Projects API] Failed to create project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// PATCH /api/control/projects/:projectId - Update project metadata
router.patch('/:projectId', requireProjectOwnership, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  try {
    const org = await getDefaultOrg(userId);
    const { name, environment } = z.object({
      name: z.string().trim().min(2).max(64).optional(),
      environment: z.enum(['development', 'staging', 'production']).optional()
    }).parse(req.body);

    const updates: any = {};
    if (name) updates.name = name;
    if (environment) updates.environment = environment;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    const [updated] = await db.update(projects)
      .set(updates)
      .where(and(eq(projects.id, projectId as string), eq(projects.orgId, org.id)))
      .returning();

    if (!updated) {
      return res.status(403).json({ error: 'Forbidden: You do not own this project' });
    }

    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', issues: error.issues });
    }
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/control/projects/:projectId - Delete project with safety guardrails
router.delete('/:projectId', requireProjectOwnership, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const projectId = req.params.projectId as string;
  try {
    const org = await getDefaultOrg(userId);
    const allUserProjects = await db.select().from(projects).where(eq(projects.orgId, org.id));

    if (!allUserProjects.some((p) => p.id === projectId)) {
      return res.status(403).json({ error: 'Forbidden: You do not own this project' });
    }

    // Safety guardrail: Do not allow deleting the last project
    if (allUserProjects.length <= 1) {
      return res.status(400).json({
        error: 'Cannot delete the only remaining project. Your account must maintain at least one active API project.'
      });
    }

    const { verifications, workflowRuns, webhooks, webhookDeliveries } = await import('../db/schema.js');
    const { invalidateApiKeyCache } = await import('../gateway/index.js');
    const { publishKeyRevocation } = await import('../lib/key-invalidation.js');

    // Cascade cleanups for foreign-key safety across PostgreSQL & pg-mem
    const routes = await db.select({ id: apiRoutes.id }).from(apiRoutes).where(eq(apiRoutes.projectId, projectId));
    const routeIds = routes.map(r => r.id);

    await db.delete(workflowRuns).where(eq(workflowRuns.projectId, projectId));
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.projectId, projectId));
    await db.delete(webhooks).where(eq(webhooks.projectId, projectId));

    if (routeIds.length > 0) {
      const exps = await db.select({ id: experiments.id }).from(experiments).where(inArray(experiments.routeId, routeIds));
      const expIds = exps.map(e => e.id);
      if (expIds.length > 0) {
        await db.delete(verifications).where(inArray(verifications.experimentId, expIds));
      }
      await db.delete(securityPolicies).where(inArray(securityPolicies.routeId, routeIds));
      await db.delete(experiments).where(inArray(experiments.routeId, routeIds));
      await db.delete(metricLogs).where(inArray(metricLogs.routeId, routeIds));
      await db.delete(securityEvents).where(inArray(securityEvents.routeId, routeIds));
      await db.delete(apiRoutes).where(inArray(apiRoutes.id, routeIds));
    }

    await db.delete(apiKeys).where(eq(apiKeys.projectId, projectId));
    await db.delete(projectSettings).where(eq(projectSettings.projectId, projectId));
    await db.delete(auditLogs).where(eq(auditLogs.projectId, projectId));
    invalidateSettingsCache(projectId);

    // Evict any cached API keys for this deleted project locally and across distributed nodes
    invalidateApiKeyCache(undefined, projectId);
    await publishKeyRevocation({
      event: 'api_key.revoked_all',
      projectId,
      timestamp: new Date().toISOString(),
    });

    // Finally delete the project itself
    await db.delete(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, org.id)));

    // Pick the fallback active project
    const remaining = allUserProjects.filter(p => p.id !== projectId);
    const nextActiveProject = remaining[0];

    res.json({
      message: 'Project and all associated configurations deleted successfully',
      nextActiveProjectId: nextActiveProject?.id
    });
  } catch (error) {
    console.error('[Projects API] Failed to delete project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// POST /api/control/projects/:projectId/policy-preset - Apply a preconfigured policy preset
router.post('/:projectId/policy-preset', requireProjectOwnership, async (req: AuthRequest, res) => {
  const { projectId } = req.params;
  const userId = req.user!.id;

  try {
    const { preset } = z.object({
      preset: z.enum(['strict', 'balanced', 'permissive'])
    }).parse(req.body);

    let rateLimitRpm = 60;
    let upstreamTimeout = 5000;
    let threatDetect = true;
    let failureMode: 'FAIL_CLOSED' | 'FAIL_OPEN' = 'FAIL_CLOSED';

    if (preset === 'strict') {
      rateLimitRpm = 30;
      upstreamTimeout = 3000;
      threatDetect = true;
      failureMode = 'FAIL_CLOSED';
    } else if (preset === 'permissive') {
      rateLimitRpm = 300;
      upstreamTimeout = 10000;
      threatDetect = false;
      failureMode = 'FAIL_OPEN';
    }

    const [current] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId as string)).limit(1);

    const newGateway = {
      ...(current?.gatewayConfig as any || defaultSettings.gatewayConfig),
      upstreamTimeoutMs: upstreamTimeout,
      requestTimeoutMs: upstreamTimeout
    };

    const newSecurity = {
      ...(current?.securityConfig as any || defaultSettings.securityConfig),
      threatDetection: threatDetect,
      ssrfProtection: true
    };

    const newRateLimit = {
      ...(current?.rateLimitConfig as any || defaultSettings.rateLimitConfig),
      defaultRpm: rateLimitRpm,
      failureMode
    };

    const nextVersion = (current?.version || 0) + 1;

    let updated;
    if (current) {
      [updated] = await db.update(projectSettings)
        .set({
          version: nextVersion,
          gatewayConfig: newGateway,
          securityConfig: newSecurity,
          rateLimitConfig: newRateLimit,
          updatedBy: userId,
          updatedAt: new Date()
        })
        .where(eq(projectSettings.projectId, projectId as string))
        .returning();
    } else {
      [updated] = await db.insert(projectSettings)
        .values({
          id: uuidv4(),
          projectId: projectId as string,
          version: 1,
          gatewayConfig: newGateway,
          securityConfig: newSecurity,
          rateLimitConfig: newRateLimit,
          experimentConfig: defaultSettings.experimentConfig,
          telemetryConfig: defaultSettings.telemetryConfig,
          updatedBy: userId
        })
        .returning();
    }

    // Record audit log
    await db.insert(auditLogs).values({
      id: uuidv4(),
      projectId: projectId as string,
      userId,
      action: 'APPLY_PRESET',
      domain: 'policyPreset',
      previousVersion: current?.version || 0,
      newVersion: updated.version,
      diff: { preset, gatewayConfig: newGateway, securityConfig: newSecurity, rateLimitConfig: newRateLimit },
      timestamp: new Date()
    }).catch(() => {});

    invalidateSettingsCache(projectId as string);

    res.json({
      message: `Policy preset '${preset}' applied successfully`,
      version: updated.version,
      settings: updated
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', issues: error.issues });
    }
    console.error('[Projects API] Failed to apply policy preset:', error);
    res.status(500).json({ error: 'Failed to apply policy preset' });
  }
});

// PUT /api/control/projects/:projectId/policies - Assign customized policies for this project
router.put('/:projectId/policies', requireProjectOwnership, async (req: AuthRequest, res) => {
  const { projectId } = req.params;
  const userId = req.user!.id;

  try {
    const { gatewayConfig, securityConfig, rateLimitConfig, experimentConfig } = req.body;

    const [current] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId as string)).limit(1);
    const nextVersion = (current?.version || 0) + 1;

    const finalGateway = gatewayConfig ? gatewayConfigSchema.parse(gatewayConfig) : (current?.gatewayConfig || defaultSettings.gatewayConfig);
    const finalSecurity = securityConfig ? securityConfigSchema.parse(securityConfig) : (current?.securityConfig || defaultSettings.securityConfig);
    const finalRateLimit = rateLimitConfig ? rateLimitConfigSchema.parse(rateLimitConfig) : (current?.rateLimitConfig || defaultSettings.rateLimitConfig);
    const finalExperiment = experimentConfig ? experimentConfigSchema.parse(experimentConfig) : (current?.experimentConfig || defaultSettings.experimentConfig);

    let updated;
    if (current) {
      [updated] = await db.update(projectSettings)
        .set({
          version: nextVersion,
          gatewayConfig: finalGateway,
          securityConfig: finalSecurity,
          rateLimitConfig: finalRateLimit,
          experimentConfig: finalExperiment,
          updatedBy: userId,
          updatedAt: new Date()
        })
        .where(eq(projectSettings.projectId, projectId as string))
        .returning();
    } else {
      [updated] = await db.insert(projectSettings)
        .values({
          id: uuidv4(),
          projectId: projectId as string,
          version: 1,
          gatewayConfig: finalGateway,
          securityConfig: finalSecurity,
          rateLimitConfig: finalRateLimit,
          experimentConfig: finalExperiment,
          telemetryConfig: defaultSettings.telemetryConfig,
          updatedBy: userId
        })
        .returning();
    }

    // Record audit log
    await db.insert(auditLogs).values({
      id: uuidv4(),
      projectId: projectId as string,
      userId,
      action: 'UPDATE_POLICIES',
      domain: 'projectPolicies',
      previousVersion: current?.version || 0,
      newVersion: updated.version,
      diff: { gatewayConfig: finalGateway, securityConfig: finalSecurity, rateLimitConfig: finalRateLimit, experimentConfig: finalExperiment },
      timestamp: new Date()
    }).catch(() => {});

    invalidateSettingsCache(projectId as string);

    res.json({
      message: 'Project policies updated successfully',
      version: updated.version,
      settings: updated
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid policy configuration', issues: error.issues });
    }
    console.error('[Projects API] Failed to update project policies:', error);
    res.status(500).json({ error: 'Failed to update project policies' });
  }
});

export const projectsRouter = router;
