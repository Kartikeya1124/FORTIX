import express from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { projectSettings, auditLogs, projects } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { requireProjectOwnership } from '../middleware/project.js';
import { AuthRequest } from '../middleware/auth.js';
import { broadcast } from '../socket.js';
import { redisConnection } from '../redis.js';

const router = express.Router();

// Domain schemas with validation constraints
export const gatewayConfigSchema = z.object({
  requestTimeoutMs: z.number().min(500).max(60000).default(5000),
  upstreamTimeoutMs: z.number().min(500).max(30000).default(5000),
  maxBodyBytes: z.number().min(1024).max(52428800).default(10485760),
  enableRequestId: z.boolean().default(true),
  corsAllowedOrigins: z.array(z.string()).default(['*'])
});

export const securityConfigSchema = z.object({
  threatDetection: z.boolean().default(true),
  ssrfProtection: z.boolean().default(true),
  enforceApiKey: z.boolean().default(true),
  securityLogging: z.boolean().default(true),
  blockSuspiciousHeaders: z.boolean().default(true)
});

export const rateLimitConfigSchema = z.object({
  defaultRpm: z.number().min(1).max(50000).default(60),
  burstMultiplier: z.number().min(1).max(10).default(2),
  failureMode: z.enum(['FAIL_CLOSED', 'FAIL_OPEN', 'LOCAL_LIMIT']).default('FAIL_CLOSED'),
  keyStrategy: z.enum(['IP_AND_KEY', 'API_KEY_ONLY', 'IP_ONLY']).default('IP_AND_KEY')
});

export const experimentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxDurationSeconds: z.number().min(5).max(300).default(60),
  maxConcurrent: z.number().min(1).max(10).default(2),
  maxIntensityRps: z.number().min(1).max(500).default(50),
  requireAuthorization: z.boolean().default(true),
  autoCleanup: z.boolean().default(true)
});

export const telemetryConfigSchema = z.object({
  retentionDays: z.number().min(1).max(90).default(14),
  liveStreaming: z.boolean().default(true),
  collectMetrics: z.boolean().default(true),
  collectSecurityEvents: z.boolean().default(true),
  samplingRatePercent: z.number().min(1).max(100).default(100)
});

export const defaultSettings = {
  gatewayConfig: gatewayConfigSchema.parse({}),
  securityConfig: securityConfigSchema.parse({}),
  rateLimitConfig: rateLimitConfigSchema.parse({}),
  experimentConfig: experimentConfigSchema.parse({}),
  telemetryConfig: telemetryConfigSchema.parse({})
};

// In-memory cache for fast lookups by gateway and workers
const settingsCache = new Map<string, { version: number; settings: any }>();

export async function getProjectSettings(projectId: string) {
  if (settingsCache.has(projectId)) {
    return settingsCache.get(projectId)!.settings;
  }

  const [existing] = await db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId)).limit(1);
  if (existing) {
    settingsCache.set(projectId, { version: existing.version, settings: existing });
    return existing;
  }

  // Initialize with defaults if none exist
  const newId = uuidv4();
  const [created] = await db.insert(projectSettings).values({
    id: newId,
    projectId,
    version: 1,
    gatewayConfig: defaultSettings.gatewayConfig,
    securityConfig: defaultSettings.securityConfig,
    rateLimitConfig: defaultSettings.rateLimitConfig,
    experimentConfig: defaultSettings.experimentConfig,
    telemetryConfig: defaultSettings.telemetryConfig,
  }).returning();

  settingsCache.set(projectId, { version: created.version, settings: created });
  return created;
}

// Invalidate cache
export function invalidateSettingsCache(projectId: string) {
  settingsCache.delete(projectId);
  redisConnection.publish('settings:invalidated', projectId).catch(() => {});
}

// GET /api/control/settings?projectId=...
router.get('/', requireProjectOwnership, async (req: AuthRequest, res) => {
  const projectId = (req.query.projectId as string) || (req as any).project?.id;
  try {
    const settings = await getProjectSettings(projectId);
    res.json(settings);
  } catch (error) {
    console.error('[Settings API] Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// GET /api/control/settings/audit-logs?projectId=...
router.get('/audit-logs', requireProjectOwnership, async (req: AuthRequest, res) => {
  const projectId = (req.query.projectId as string) || (req as any).project?.id;
  try {
    const logs = await db.select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, projectId))
      .orderBy(desc(auditLogs.timestamp))
      .limit(50);
    res.json(logs);
  } catch (error) {
    console.error('[Settings API] Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// PATCH /api/control/settings/:domain
router.patch('/:domain', requireProjectOwnership, async (req: AuthRequest, res) => {
  const projectId = (req.query.projectId as string) || req.body.projectId || (req as any).project?.id;
  const domain = req.params.domain as string;
  const userId = req.user?.id;

  const validDomains = ['gateway', 'security', 'rateLimit', 'experiments', 'telemetry'];
  if (!validDomains.includes(domain)) {
    return res.status(400).json({ error: `Invalid domain. Must be one of: ${validDomains.join(', ')}` });
  }

  try {
    const current = await getProjectSettings(projectId);

    // Optimistic Concurrency Control
    if (typeof req.body.expectedVersion === 'number' && req.body.expectedVersion !== current.version) {
      return res.status(409).json({
        error: 'CONFIG_VERSION_CONFLICT',
        message: 'Settings were modified by another session. Please reload and try again.',
        currentVersion: current.version,
        expectedVersion: req.body.expectedVersion
      });
    }

    let parsedConfig: any;
    let configColumn: 'gatewayConfig' | 'securityConfig' | 'rateLimitConfig' | 'experimentConfig' | 'telemetryConfig';

    switch (domain) {
      case 'gateway':
        parsedConfig = gatewayConfigSchema.parse(req.body.config);
        configColumn = 'gatewayConfig';
        break;
      case 'security':
        parsedConfig = securityConfigSchema.parse(req.body.config);
        configColumn = 'securityConfig';
        break;
      case 'rateLimit':
        parsedConfig = rateLimitConfigSchema.parse(req.body.config);
        configColumn = 'rateLimitConfig';
        break;
      case 'experiments':
        parsedConfig = experimentConfigSchema.parse(req.body.config);
        configColumn = 'experimentConfig';
        break;
      case 'telemetry':
        parsedConfig = telemetryConfigSchema.parse(req.body.config);
        configColumn = 'telemetryConfig';
        break;
      default:
        return res.status(400).json({ error: 'Unsupported domain' });
    }

    const previousConfig = (current as any)[configColumn];
    const newVersion = current.version + 1;

    // Update in database
    const [updated] = await db.update(projectSettings)
      .set({
        [configColumn]: parsedConfig,
        version: newVersion,
        updatedBy: userId,
        updatedAt: new Date()
      })
      .where(eq(projectSettings.id, current.id))
      .returning();

    // Record audit log
    await db.insert(auditLogs).values({
      id: uuidv4(),
      projectId,
      userId: userId || null,
      action: 'SETTINGS_UPDATE',
      domain,
      previousVersion: current.version,
      newVersion,
      diff: {
        domain,
        before: previousConfig,
        after: parsedConfig
      },
      metadata: {
        ip: req.ip,
        userAgent: req.headers['user-agent']
      }
    });

    // Update cache and broadcast
    invalidateSettingsCache(projectId);
    settingsCache.set(projectId, { version: newVersion, settings: updated });

    broadcast(projectId, 'settings:updated', {
      domain,
      version: newVersion,
      config: parsedConfig
    });

    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: error.issues });
    }
    console.error(`[Settings API] Error updating ${domain} settings:`, error);
    res.status(500).json({ error: `Failed to update ${domain} settings` });
  }
});

export const settingsRouter = router;
