import { Express } from 'express';
import cookieParser from 'cookie-parser';
import { accountRouter } from "./account.js";
import { authRouter } from "./auth.js";
import { adminRouter } from './admin.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { requireEntitlement } from '../middleware/entitlements.js';
import { csrfProtectionMiddleware } from '../lib/cors-csrf.js';
import { projectsRouter } from './projects.js';
import { apiRoutesRouter } from './routes.js';
import { apiKeysRouter } from './keys.js';
import { policiesRouter } from './policies.js';
import { experimentsRouter } from './experiments.js';
import { metricsRouter } from './metrics.js';
import { verificationsRouter } from './verifications.js';
import { eventsRouter } from './events.js';
import { webhooksRouter } from './webhooks.js';
import { resourcesRouter } from './resources.js';
import { topologyRouter } from './topology.js';
import { settingsRouter } from './settings.js';
import { systemRouter, getDependenciesHealth } from './system.js';
import { dlqRouter } from './dlq.js';
import reportsRouter from './reports.js';
import { workflowRunsRouter } from './runs.js';
import { openApiRouter, getSwaggerHtml } from './openapi.js';
import { register, httpRequestsTotal, httpRequestDurationSeconds } from '../lib/metrics.js';
import { db } from '../db/index.js';
import { redisConnection } from '../redis.js';
import { sql } from 'drizzle-orm';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';

export function setupApiRoutes(app: Express) {
  app.use(cookieParser());
  app.use((req, res, next) => {
    req.id = (req.headers['x-request-id'] as string) || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    next();
  });
  app.use('/api', csrfProtectionMiddleware);

  // Prometheus Metrics Tracker (with bounded route label cardinality)
  app.use((req, res, next) => {
    if (req.path === '/metrics') return next();
    const start = process.hrtime();
    res.on('finish', () => {
      const [seconds, nanoseconds] = process.hrtime(start);
      const durationInSeconds = seconds + nanoseconds / 1e9;
      let routePath = 'unmatched';
      if (req.route?.path) {
        const suffix = typeof req.route.path === 'string' && req.route.path !== '/' ? req.route.path : '';
        routePath = `${req.baseUrl || ''}${suffix}` || '/';
      } else if (req.baseUrl) {
        routePath = req.baseUrl;
      } else if (req.path.startsWith('/proxy/')) {
        routePath = '/proxy/:routeId';
      } else if (res.statusCode < 400) {
        routePath = req.path || 'unknown';
      }
      httpRequestsTotal.inc({
        method: req.method,
        route: routePath,
        status_code: res.statusCode.toString()
      });
      httpRequestDurationSeconds.observe({
        method: req.method,
        route: routePath,
        status_code: res.statusCode.toString()
      }, durationInSeconds);
    });
    next();
  });

  const pinoMiddleware = pinoHttp({ logger, genReqId: (req) => req.id });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/proxy')) {
      pinoMiddleware(req, res, next);
    } else {
      next();
    }
  });

  // Health Checks
  app.get('/api/health', async (req, res) => {
    const health = await getDependenciesHealth();
    res.status(200).json(health);
  });

  app.get('/api/health/live', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/health/ready', async (req, res) => {
    const health = await getDependenciesHealth();
    const strictDb = process.env.STRICT_PERSISTENT_DB === 'true';
    const strictRedis = process.env.STRICT_REDIS_READINESS === 'true';
    const isPostgresReady =
      health.postgres.status === 'healthy' &&
      (!strictDb || health.postgres.storageMode === 'persistent');
    const isRedisReady = !strictRedis || health.redis.status === 'healthy';
    const isReady = isPostgresReady && isRedisReady;

    res.status(isReady ? 200 : 503).json({
      status: isReady && health.status === 'healthy' ? 'ok' : isReady ? 'degraded' : 'unhealthy',
      postgres: health.postgres.status,
      postgresStorageMode: health.postgres.storageMode,
      redis: health.redis.status,
      redisStorageMode: health.redis.storageMode,
    });
  });

  app.get('/api/health/dependencies', async (req, res) => {
    const health = await getDependenciesHealth();
    res.status(200).json(health);
  });

  // Prometheus Metrics Exposition
  app.get('/metrics', async (req, res) => {
    try {
      res.setHeader('Content-Type', register.contentType);
      res.send(await register.metrics());
    } catch (err) {
      res.status(500).send(err instanceof Error ? err.message : 'Error retrieving metrics');
    }
  });

  // OpenAPI 3 Specification & Interactive Docs
  app.use('/api', openApiRouter);
  app.get('/api-docs', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getSwaggerHtml('/api/openapi.json'));
  });
  app.get('/api/docs', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getSwaggerHtml('/api/openapi.json'));
  });

  // Public
  app.use("/api/auth", authRouter);
  app.use("/api/control/account", authenticate, accountRouter);

  // Protected Control Plane
  app.use('/api/control/system', systemRouter);
  app.use('/api/control/settings', authenticate, settingsRouter);
  app.use('/api/control/projects', authenticate, projectsRouter);
  app.use('/api/control/routes', authenticate, apiRoutesRouter);
  app.use('/api/control/keys', authenticate, apiKeysRouter);
  app.use('/api/control/policies', authenticate, policiesRouter);
  app.use('/api/control/experiments', authenticate, requireEntitlement('ADVANCED_EXPERIMENTS'), experimentsRouter);
  app.use('/api/control/metrics', authenticate, requireEntitlement('ADVANCED_ANALYTICS'), metricsRouter);
  app.use('/api/control/verifications', authenticate, requireEntitlement('POLICY_VERIFICATION'), verificationsRouter);
  app.use('/api/control/events', authenticate, eventsRouter);
  app.use('/api/control/webhooks', authenticate, requireEntitlement('ADVANCED_SECURITY'), webhooksRouter);
  app.use('/api/control/resources', authenticate, requireEntitlement('TOPOLOGY'), resourcesRouter);
  app.use('/api/control/topology', authenticate, requireEntitlement('TOPOLOGY'), topologyRouter);
  app.use('/api/control/dlq', authenticate, dlqRouter);
  app.use('/api/control/queue', authenticate, dlqRouter);
  app.use('/api/control/admin', authenticate, requireAdmin, adminRouter);
  app.use('/api/control/runs', authenticate, workflowRunsRouter);
  app.use('/api', reportsRouter);

  // Structured JSON 404 handler for unmatched /api/* routes (never fall through to HTML SPA)
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'Requested API endpoint does not exist.',
      code: 'API_ROUTE_NOT_FOUND',
      path: req.originalUrl,
      requestId: req.id,
    });
  });
}
