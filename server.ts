import express from 'express';
import cookieParser from 'cookie-parser';

// Start internal background queue workers only if enabled (defaults to true for standalone/dev, false for multi-process worker setups)
if (process.env.START_INTERNAL_WORKER !== 'false') {
  import('./src/worker.js').catch(err => {
    console.warn('[Worker] Internal worker startup warning:', err?.message || err);
  });
}

// Start demo upstream API only if enabled (defaults to true for development)
if (process.env.START_DEMO_API !== 'false') {
  import('./demo-api.js').catch(err => {
    console.warn('[DemoApi] Demo API startup warning:', err?.message || err);
  });
}
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { setupApiRoutes } from './src/api/index.js';
import { setupGateway } from './src/gateway/index.js';
import { setupWebSockets } from './src/socket.js';
import http from 'http';
import { db } from './src/db/index.js';
import { initDatabase } from './src/db/init.js';
import { redisConnection } from './src/redis.js';
import { sql } from 'drizzle-orm';
import { getDependenciesHealth } from './src/api/system.js';

// Handle uncaught exceptions and unhandled rejections gracefully
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('ECONNREFUSED')) return;
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason: any) => {
  if (reason && reason.message && reason.message.includes('ECONNREFUSED')) return;
  console.error('Unhandled Rejection:', reason);
});

let isShuttingDown = false;

// Production Security Guardrails
export function validateProductionJwtSecret(secret?: string): { valid: boolean; reason?: string } {
  if (!secret || typeof secret !== 'string') {
    return { valid: false, reason: 'JWT_SECRET is missing or empty' };
  }
  if (secret.length < 32) {
    return { valid: false, reason: 'JWT_SECRET must be at least 32 characters long' };
  }
  const disallowedDefaults = [
    'dev_secret_key',
    'secret',
    'changeme',
    'production-secret-change-me',
    'password',
    'fortix_secret',
    '12345678901234567890123456789012',
    'abcdefghijklmnopqrstuvwxyz123456'
  ];
  if (disallowedDefaults.includes(secret.toLowerCase())) {
    return { valid: false, reason: 'JWT_SECRET contains a known development placeholder or default password' };
  }
  const distinctChars = new Set(secret).size;
  if (distinctChars < 8) {
    return { valid: false, reason: 'JWT_SECRET has insufficient entropy (fewer than 8 distinct characters)' };
  }
  return { valid: true };
}

if (process.env.NODE_ENV === 'production') {
  const validation = validateProductionJwtSecret(process.env.JWT_SECRET);
  if (!validation.valid) {
    console.error(`[SECURITY FATAL] Production startup rejected: ${validation.reason}.`);
    process.exit(1);
  }
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  
  // Health checks
  app.get('/health/live', (req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({ status: 'shutting_down' });
    }
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/health/ready', async (req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({ status: 'shutting_down' });
    }
    const health = await getDependenciesHealth();
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json({ status: health.status, postgres: health.postgres, redis: health.redis });
  });

  app.get('/health/dependencies', async (req, res) => {
    const health = await getDependenciesHealth();
    res.status(200).json(health);
  });

  app.get('/health', async (req, res) => {
    const health = await getDependenciesHealth();
    res.status(200).json(health);
  });

  const server = http.createServer(app);
  server.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      console.warn(`[Server] Port ${PORT} already in use. Retrying in 1s...`);
      setTimeout(() => {
        try {
          server.listen(PORT, '0.0.0.0');
        } catch {}
      }, 1000);
    } else {
      console.error('[Server] Fatal server error:', err);
    }
  });

  setupWebSockets(server);

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  setupApiRoutes(app);
  setupGateway(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`FortiX Server running on http://0.0.0.0:${PORT}`);
  });

  // Run migrations without blocking the initial TCP probe listener
  initDatabase().then(async () => {
    // Reconcile any abandoned workflow runs from prior process restarts/crashes
    try {
      const { reconcileAbandonedRuns } = await import('./src/autonomous/stateMachine.js');
      const result = await reconcileAbandonedRuns();
      if (result.reconciledCount > 0) {
        console.log(`[Recovery] Reconciled ${result.reconciledCount} abandoned workflow run(s) into RECOVERY_REQUIRED:`, result.runIds);
      }
    } catch (recErr: any) {
      console.warn('[Recovery] Warning during startup run reconciliation:', recErr?.message || recErr);
    }
  }).catch((err) => {
    console.error('[Database] Fatal startup migration error:', err?.message || err);
    if (process.env.NODE_ENV === 'production' || process.env.STRICT_PERSISTENT_DB === 'true') {
      console.error('[Database] STRICT_PERSISTENT_DB or production mode is active. Process exiting due to unapplied migrations.');
      process.exit(1);
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('Received shutdown signal, starting graceful shutdown...');

    server.close(async () => {
      console.log('HTTP server closed.');
      try {
        await redisConnection.quit();
        console.log('Redis connection closed.');
      } catch (e) {
        console.error('Error closing Redis connection:', e);
      }
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch(console.error);
