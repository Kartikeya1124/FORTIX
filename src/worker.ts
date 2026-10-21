import { Worker, Queue } from 'bullmq';
import { db } from './db/index.js';
import { metricLogs, experiments } from './db/schema.js';
import { runExperimentLogic } from './experiments/worker.js';
import { eq, and, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { registerQueue, recordDlqFailure } from './lib/dlq.js';
import { logger } from './lib/logger.js';
import { processTelemetryBatch } from './telemetry-worker.js';
import { executeWebhookDelivery } from './lib/webhooks.js';

function getRedisConnectionConfig() {
  if (process.env.REDIS_URL) {
    try {
      const url = new URL(process.env.REDIS_URL);
      return {
        host: url.hostname || 'localhost',
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
        username: url.username || undefined,
        db: url.pathname && url.pathname.length > 1 ? parseInt(url.pathname.replace('/', ''), 10) : 0,
      };
    } catch {
      // fallback to host/port
    }
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  };
}

const redisConnection = getRedisConnectionConfig();

const cleanupQueue = new Queue('cleanup', { connection: redisConnection as any });
registerQueue('cleanup', cleanupQueue);

cleanupQueue.on('error', (err: any) => {
  if (err?.message?.includes('ECONNREFUSED')) return;
  logger.error({ err }, '[BullMQ cleanupQueue] Error');
});

const experimentWorker = new Worker('experiments', async job => {
  if (job.name === 'run-experiment') {
    await runExperimentLogic(job.data.experimentId);
  }
}, { connection: redisConnection as any });

experimentWorker.on('error', (err: any) => {
  if (err?.message?.includes('ECONNREFUSED')) return;
  logger.error({ err }, '[BullMQ experimentWorker] Error');
});

experimentWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsMade = job.attemptsMade;
  const maxAttempts = job.opts?.attempts || 3;

  logger.warn({
    jobId: job.id,
    name: job.name,
    attemptsMade,
    maxAttempts,
    err: err?.message
  }, '[BullMQ experimentWorker] Job attempt failed');

  if (attemptsMade >= maxAttempts) {
    await recordDlqFailure({
      jobId: job.id || `exp-job-${Date.now()}`,
      queueName: 'experiments',
      jobName: job.name,
      data: job.data,
      failedReason: err?.message || 'Job execution failed after max retries',
      stacktrace: err?.stack ? [err.stack] : job.stacktrace || [],
      attemptsMade,
      maxAttempts
    });
  }
});

// Dedicated Webhook Redelivery Worker
const webhookWorker = new Worker('fortix-webhooks', async job => {
  if (job.name === 'deliver-webhook') {
    const attempt = (job.attemptsMade || 0) + 1;
    await executeWebhookDelivery(job.data, attempt);
  }
}, { connection: redisConnection as any });

webhookWorker.on('error', (err: any) => {
  if (err?.message?.includes('ECONNREFUSED')) return;
  logger.error({ err }, '[BullMQ webhookWorker] Error');
});

webhookWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsMade = job.attemptsMade;
  const maxAttempts = job.opts?.attempts || 5;

  logger.warn({
    jobId: job.id,
    name: job.name,
    attemptsMade,
    maxAttempts,
    err: err?.message,
  }, '[BullMQ webhookWorker] Webhook delivery attempt failed');

  if (attemptsMade >= maxAttempts) {
    await recordDlqFailure({
      jobId: job.id || `wh-job-${Date.now()}`,
      queueName: 'fortix-webhooks',
      jobName: job.name,
      data: job.data,
      failedReason: err?.message || 'Webhook delivery failed after 5 exponential attempts',
      stacktrace: err?.stack ? [err.stack] : job.stacktrace || [],
      attemptsMade,
      maxAttempts,
    });
  }
});

// Schedule the cleanup job to run every hour
cleanupQueue.add('reaper', {}, { repeat: { pattern: '*/5 * * * *' } } as any);
cleanupQueue.add('telemetry-ttl', {}, { repeat: { pattern: '0 * * * *' } } as any);

const cleanupWorker = new Worker('cleanup', async job => {
  if (job.name === 'telemetry-ttl') {
    // Delete metric logs older than 7 days
    await db.execute(sql`
      DELETE FROM ${metricLogs} 
      WHERE timestamp < NOW() - INTERVAL '7 days'
    `);
    logger.info('Cleaned up telemetry older than 7 days');
  } else if (job.name === 'reaper') {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
    await db.update(experiments).set({ status: 'FAILED' })
      .where(and(eq(experiments.status, 'RUNNING'), lt(experiments.startedAt, fiveMinsAgo)));
    logger.info('Reaped orphaned experiments');
  }
}, { connection: redisConnection as any });

cleanupWorker.on('error', (err: any) => {
  if (err?.message?.includes('ECONNREFUSED')) return;
  logger.error({ err }, '[BullMQ cleanupWorker] Error');
});

cleanupWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsMade = job.attemptsMade;
  const maxAttempts = job.opts?.attempts || 3;

  if (attemptsMade >= maxAttempts) {
    await recordDlqFailure({
      jobId: job.id || `cleanup-job-${Date.now()}`,
      queueName: 'cleanup',
      jobName: job.name,
      data: job.data,
      failedReason: err?.message || 'Cleanup job execution failed',
      stacktrace: err?.stack ? [err.stack] : job.stacktrace || [],
      attemptsMade,
      maxAttempts
    });
  }
});

logger.info('BullMQ workers initialized with DLQ failure routing');

// Start the telemetry ingestion loop
processTelemetryBatch().catch((err) => {
  logger.error({ err }, 'Telemetry ingestion loop error');
});
