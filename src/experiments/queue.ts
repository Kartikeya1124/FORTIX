import { Queue } from 'bullmq';
import { redisConnection, isRealRedisActive, getBullMqConnectionOptions } from '../redis.js';
import { runExperimentLogic } from './worker.js';
import { registerQueue, recordDlqFailure } from '../lib/dlq.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../lib/logger.js';

export const experimentQueue = new Queue('experiments', {
  connection: (isRealRedisActive ? getBullMqConnectionOptions() : redisConnection) as any,
});

registerQueue('experiments', experimentQueue);

experimentQueue.on('error', (err: any) => {
  const msg = String(err?.message || '');
  if (msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND')) return;
  logger.error({ err }, '[BullMQ experiments queue] Error');
});

export const DEFAULT_EXPERIMENT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: {
    count: 100,
    age: 86400,
  },
  removeOnFail: false,
};

function dispatchFallbackExperimentRunner(experimentId: string) {
  setTimeout(async () => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runExperimentLogic(experimentId);
        return;
      } catch (err: any) {
        if (attempt >= maxAttempts) {
          await recordDlqFailure({
            jobId: `direct-exp-${experimentId}-${uuidv4().slice(0, 8)}`,
            queueName: 'experiments',
            jobName: 'run-experiment',
            data: { experimentId },
            failedReason: err instanceof Error ? err.message : String(err),
            stacktrace: err instanceof Error && err.stack ? [err.stack] : [],
            attemptsMade: attempt,
            maxAttempts,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  }, 50);
}

export async function enqueueExperiment(experimentId: string) {
  if (!isRealRedisActive) {
    dispatchFallbackExperimentRunner(experimentId);
    return;
  }

  try {
    await experimentQueue.add('run-experiment', { experimentId }, DEFAULT_EXPERIMENT_JOB_OPTIONS);
  } catch (err) {
    logger.warn({ err, experimentId }, '[Experiments] BullMQ add failed, falling back to bounded local runner');
    dispatchFallbackExperimentRunner(experimentId);
  }
}
