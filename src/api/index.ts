import { Express } from 'express';
import { accountRouter } from "./account.js";
import { authRouter } from "./auth.js";
import { authenticate } from '../middleware/auth.js';
import { requireEntitlement } from '../middleware/entitlements.js';
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
  app.use((req, res, next) => {
    req.id = (req.headers['x-request-id'] as string) || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    next();
  });

  // Prometheus Metrics Tracker
  app.use((req, res, next) => {
    if (req.path === '/metrics') return next();
    const start = process.hrtime();
    res.on('finish', () => {
      const [seconds, nanoseconds] = process.hrtime(start);
      const durationInSeconds = seconds + nanoseconds / 1e9;
      const routePath = req.baseUrl || req.route?.path || req.path || 'unknown';
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
    res.status(200).json({
      status: health.status === 'healthy' ? 'ok' : 'degraded',
      postgres: health.postgres.status,
      redis: health.redis.status
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
  app.use('/api/control/runs', authenticate, workflowRunsRouter);
  app.use('/api', reportsRouter);
}
