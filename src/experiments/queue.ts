import { Queue } from 'bullmq';
import { redisConnection, isRealRedisActive, getBullMqConnectionOptions } from '../redis.js';
import { runExperimentLogic } from './worker.js';
import { registerQueue, recordDlqFailure } from '../lib/dlq.js';
import { v4 as uuidv4 } from 'uuid';

export const experimentQueue = new Queue('experiments', {
  connection: (isRealRedisActive ? getBullMqConnectionOptions() : redisConnection) as any,
});

registerQueue('experiments', experimentQueue);

experimentQueue.on('error', (err: any) => {
  const msg = String(err?.message || '');
  if (msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND')) return;
  console.error('[BullMQ experiments queue] Error:', err);
});

export const DEFAULT_EXPERIMENT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000
  },
  removeOnComplete: {
    count: 100,
    age: 86400
  },
  removeOnFail: false
};

export async function enqueueExperiment(experimentId: string) {
  try {
    await experimentQueue.add('run-experiment', { experimentId }, DEFAULT_EXPERIMENT_JOB_OPTIONS);
  } catch (e) {
    console.error('BullMQ not supported in ioredis-mock, falling back to direct execution for', experimentId);
    setTimeout(() => {
      runExperimentLogic(experimentId).catch(async (err) => {
        console.error('Direct experiment execution failed:', err);
        await recordDlqFailure({
          jobId: `direct-exp-${experimentId}-${uuidv4().slice(0, 8)}`,
          queueName: 'experiments',
          jobName: 'run-experiment',
          data: { experimentId },
          failedReason: err instanceof Error ? err.message : String(err),
          stacktrace: err instanceof Error && err.stack ? [err.stack] : [],
          attemptsMade: 1,
          maxAttempts: 3
        });
      });
    }, 100);
  }
}
