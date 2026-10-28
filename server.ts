import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import cors from 'cors';
import http from 'http';

// Handle uncaught exceptions and unhandled rejections gracefully
process.on('uncaughtException', (err) => {
  if (err?.message && err.message.includes('ECONNREFUSED')) return;
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason: any) => {
  if (reason?.message && reason.message.includes('ECONNREFUSED')) return;
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

export function resolveServerPort(argv = process.argv, env = process.env): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (arg.startsWith('--port=')) {
      const parsed = parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  if (env.NODE_ENV === 'production' && env.PORT) {
    const parsed = parseInt(env.PORT, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (env.PORT && env.PORT !== '8080') {
    const parsed = parseInt(env.PORT, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3000;
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
  const PORT = resolveServerPort();

  // Immediate liveness probe before heavy module/Vite initialization
  app.get('/health/live', (_req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({ status: 'shutting_down' });
    }
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

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

  // Bind TCP listener immediately so cold-boot readiness probes never time out
  await new Promise<void>((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`FortiX Server listening on http://0.0.0.0:${PORT}`);
      resolve();
    });
  });

  // Dynamic router populated asynchronously; in-flight requests await bootstrapPromise seamlessly
  const runtimeRouter = express.Router();
  let redisQuit: (() => Promise<unknown>) | null = null;

  const bootstrapPromise = (async () => {
    const [
      { setupWebSockets },
      { getDependenciesHealth },
      { setupApiRoutes },
      { setupGateway },
      { initDatabase },
      { redisConnection }
    ] = await Promise.all([
      import('./src/socket.js'),
      import('./src/api/system.js'),
      import('./src/api/index.js'),
      import('./src/gateway/index.js'),
      import('./src/db/init.js'),
      import('./src/redis.js')
    ]);

    redisQuit = () => redisConnection.quit();

    setupWebSockets(server);

    runtimeRouter.get('/health/ready', async (_req, res) => {
      if (isShuttingDown) {
        return res.status(503).json({ status: 'shutting_down' });
      }
      const health = await getDependenciesHealth();
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json({
        status: health.status,
        postgres: health.postgres,
        redis: health.redis
      });
    });

    runtimeRouter.get('/health/dependencies', async (_req, res) => {
      const health = await getDependenciesHealth();
      res.status(200).json(health);
    });

    runtimeRouter.get('/health', async (_req, res) => {
      const health = await getDependenciesHealth();
      res.status(200).json(health);
    });

    setupApiRoutes(runtimeRouter as any);
    setupGateway(runtimeRouter as any);

    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: false,
          watch: null
        },
        appType: 'spa'
      });
      runtimeRouter.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      runtimeRouter.use(express.static(distPath));
      runtimeRouter.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    // Run migrations and abandoned-workflow reconciliation asynchronously
    initDatabase()
      .then(async () => {
        try {
          const { reconcileAbandonedRuns } = await import('./src/autonomous/stateMachine.js');
          const result = await reconcileAbandonedRuns();
          if (result.reconciledCount > 0) {
            console.log(
              `[Recovery] Reconciled ${result.reconciledCount} abandoned workflow run(s) into RECOVERY_REQUIRED:`,
              result.runIds
            );
          }
        } catch (recErr: any) {
          console.warn('[Recovery] Warning during startup run reconciliation:', recErr?.message || recErr);
        }
      })
      .catch((err) => {
        console.error('[Database] Fatal startup migration error:', err?.message || err);
        if (process.env.NODE_ENV === 'production' || process.env.STRICT_PERSISTENT_DB === 'true') {
          console.error('[Database] STRICT_PERSISTENT_DB or production mode is active. Process exiting due to unapplied migrations.');
          process.exit(1);
        }
      });

    // Defer internal demo API and background worker until HTTP & Vite routes are ready
    setTimeout(() => {
      if (process.env.START_DEMO_API !== 'false') {
        import('./demo-api.js').catch((err) => {
          console.warn('[DemoApi] Demo API startup warning:', err?.message || err);
        });
      }
      if (process.env.START_INTERNAL_WORKER !== 'false') {
        import('./src/worker.js').catch((err) => {
          console.warn('[Worker] Internal worker startup warning:', err?.message || err);
        });
      }
    }, 150);
  })();

  bootstrapPromise.catch((err) => {
    console.error('[Server] Bootstrap initialization error:', err);
  });

  app.use(async (req, res, next) => {
    try {
      await bootstrapPromise;
      runtimeRouter(req, res, next);
    } catch (err) {
      next(err);
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
        if (redisQuit) {
          await redisQuit();
          console.log('Redis connection closed.');
        }
      } catch (e) {
        console.error('Error closing Redis connection:', e);
      }
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer().catch((err) => {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  });
}
