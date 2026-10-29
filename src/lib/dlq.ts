import { Queue } from 'bullmq';
import { db } from '../db/index.js';
import { experiments, apiRoutes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { dlqJobsTotal, dlqRetriesTotal, dlqCurrentGauge } from './metrics.js';
import { logger } from './logger.js';

export interface DlqJobRecord {
  id: string;
  queueName: string;
  jobName: string;
  experimentId?: string;
  projectId?: string;
  data: any;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  maxAttempts: number;
  failedAt: string;
  status: 'DEAD_LETTER' | 'FAILED' | 'RETRYING' | 'RESOLVED';
}

export interface QueueHealthStats {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

const SENSITIVE_DLQ_KEYS = new Set([
  'secret',
  'secrethash',
  'rawkey',
  'password',
  'currentpassword',
  'newpassword',
  'token',
  'authorization',
  'x-api-key',
  'x-fortix-token',
]);

export function sanitizeDlqPayload(value: any, depth = 0): any {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDlqPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_DLQ_KEYS.has(k.toLowerCase())) {
        out[k] = v ? '[REDACTED]' : v;
      } else {
        out[k] = sanitizeDlqPayload(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// In-memory persistent registry for DLQ records to ensure reliability across runtime modes (Real Redis / Mock)
export const inMemoryDlqStore = new Map<string, DlqJobRecord>();

// Known BullMQ Queues
const registeredQueues = new Map<string, Queue>();

export function registerQueue(name: string, queue: Queue) {
  registeredQueues.set(name, queue);
}

export function getRegisteredQueue(name: string): Queue | undefined {
  return registeredQueues.get(name);
}

export async function resolveDlqJobProjectId(job: DlqJobRecord): Promise<string | undefined> {
  if (job.projectId && typeof job.projectId === 'string') {
    return job.projectId;
  }
  if (job.data && typeof job.data === 'object' && typeof job.data.projectId === 'string' && job.data.projectId) {
    job.projectId = job.data.projectId;
    return job.projectId;
  }
  if (job.experimentId) {
    try {
      const [expRow] = await db
        .select({ routeId: experiments.routeId })
        .from(experiments)
        .where(eq(experiments.id, job.experimentId))
        .limit(1);
      if (expRow?.routeId) {
        const [routeRow] = await db
          .select({ projectId: apiRoutes.projectId })
          .from(apiRoutes)
          .where(eq(apiRoutes.id, expRow.routeId))
          .limit(1);
        if (routeRow?.projectId) {
          job.projectId = routeRow.projectId;
          return job.projectId;
        }
      }
    } catch {
      // Ignore lookup failures for synthetic/deleted experiment IDs
    }
  }
  return undefined;
}

export async function isDlqJobVisibleToTenant(
  job: DlqJobRecord,
  allowedProjectIds?: Set<string>,
  explicitProjectId?: string
): Promise<boolean> {
  const jobProjectId = await resolveDlqJobProjectId(job);
  if (explicitProjectId) {
    return jobProjectId === explicitProjectId;
  }
  if (!allowedProjectIds) {
    return true;
  }
  if (!jobProjectId) {
    // Unscoped system/diagnostic DLQ jobs have no tenant project binding
    return true;
  }
  return allowedProjectIds.has(jobProjectId);
}

/**
 * Record a failed job into the Dead-Letter Queue
 */
export async function recordDlqFailure(params: {
  jobId: string;
  queueName: string;
  jobName: string;
  data: any;
  failedReason: string;
  stacktrace?: string[];
  attemptsMade?: number;
  maxAttempts?: number;
}) {
  const experimentId = params.data?.experimentId || (typeof params.data === 'string' ? params.data : undefined);
  const directProjectId = typeof params.data?.projectId === 'string' ? params.data.projectId : undefined;
  const attemptsMade = params.attemptsMade ?? 3;
  const maxAttempts = params.maxAttempts ?? 3;
  const sanitizedData = sanitizeDlqPayload(params.data);

  const record: DlqJobRecord = {
    id: params.jobId,
    queueName: params.queueName,
    jobName: params.jobName,
    experimentId,
    projectId: directProjectId,
    data: sanitizedData,
    failedReason: params.failedReason || 'Unknown execution failure',
    stacktrace: params.stacktrace || [],
    attemptsMade,
    maxAttempts,
    failedAt: new Date().toISOString(),
    status: 'DEAD_LETTER',
  };

  if (!record.projectId && experimentId) {
    await resolveDlqJobProjectId(record);
  }

  inMemoryDlqStore.set(params.jobId, record);

  // Update Prometheus metrics
  try {
    dlqJobsTotal.inc({ queue: params.queueName, job_name: params.jobName });
    const countForQueue = Array.from(inMemoryDlqStore.values()).filter(
      (j) => j.queueName === params.queueName && j.status === 'DEAD_LETTER'
    ).length;
    dlqCurrentGauge.set({ queue: params.queueName }, countForQueue);
  } catch {
    // Metric increment resilience
  }

  // Update Experiment record in database if experimentId is present
  if (experimentId) {
    try {
      await db
        .update(experiments)
        .set({
          status: 'FAILED',
          completedAt: new Date(),
        })
        .where(eq(experiments.id, experimentId));
    } catch (e) {
      logger.warn({ experimentId, err: e }, '[DLQ] Failed to update experiment status in DB');
    }
  }

  logger.error(
    {
      jobId: params.jobId,
      queue: params.queueName,
      jobName: params.jobName,
      experimentId,
      attemptsMade,
      reason: params.failedReason,
    },
    '[DLQ] Job permanently failed and routed to Dead-Letter Queue'
  );

  return record;
}

/**
 * Retrieve all DLQ jobs with tenant isolation, filtering, and pagination
 */
export async function listDlqJobs(
  options: {
    queueName?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
    projectId?: string;
    allowedProjectIds?: Set<string>;
  } = {}
): Promise<{ total: number; jobs: DlqJobRecord[] }> {
  const allRecords = Array.from(inMemoryDlqStore.values());
  let list: DlqJobRecord[] = [];

  for (const job of allRecords) {
    if (await isDlqJobVisibleToTenant(job, options.allowedProjectIds, options.projectId)) {
      list.push({ ...job, data: sanitizeDlqPayload(job.data) });
    }
  }

  if (options.queueName) {
    list = list.filter((j) => j.queueName.toLowerCase() === options.queueName!.toLowerCase());
  }

  if (options.status) {
    list = list.filter((j) => j.status.toLowerCase() === options.status!.toLowerCase());
  }

  if (options.search) {
    const q = options.search.toLowerCase();
    list = list.filter(
      (j) =>
        j.id.toLowerCase().includes(q) ||
        j.jobName.toLowerCase().includes(q) ||
        (j.experimentId && j.experimentId.toLowerCase().includes(q)) ||
        j.failedReason.toLowerCase().includes(q)
    );
  }

  // Sort descending by failedAt
  list.sort((a, b) => new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime());

  const total = list.length;
  const offset = options.offset || 0;
  const limit = options.limit || 50;
  const jobs = list.slice(offset, offset + limit);

  return { total, jobs };
}

/**
 * Get detailed DLQ job by ID
 */
export async function getDlqJob(jobId: string): Promise<DlqJobRecord | null> {
  const job = inMemoryDlqStore.get(jobId);
  if (!job) return null;
  return { ...job, data: sanitizeDlqPayload(job.data) };
}

/**
 * Retry a specific DLQ job
 */
export async function retryDlqJob(jobId: string): Promise<{ success: boolean; message: string; job?: DlqJobRecord }> {
  const dlqJob = inMemoryDlqStore.get(jobId);
  if (!dlqJob) {
    return { success: false, message: `DLQ Job ${jobId} not found` };
  }

  const targetQueue = registeredQueues.get(dlqJob.queueName);

  // If experiment ID exists, reset experiment status in DB
  if (dlqJob.experimentId) {
    try {
      await db
        .update(experiments)
        .set({
          status: 'QUEUED',
          completedAt: null,
        })
        .where(eq(experiments.id, dlqJob.experimentId));
    } catch (err) {
      logger.warn({ experimentId: dlqJob.experimentId, err }, '[DLQ] Failed to reset experiment status for retry');
    }
  }

  // Try re-adding to target BullMQ Queue
  if (targetQueue) {
    try {
      await targetQueue.add(dlqJob.jobName, dlqJob.data, {
        attempts: dlqJob.maxAttempts || 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
    } catch (queueErr) {
      logger.warn({ jobId, err: queueErr }, '[DLQ] Error re-enqueuing job to BullMQ');
    }
  }

  dlqJob.status = 'RETRYING';
  dlqJob.failedAt = new Date().toISOString();

  // Metrics
  try {
    dlqRetriesTotal.inc({ queue: dlqJob.queueName, job_name: dlqJob.jobName });
    const countForQueue = Array.from(inMemoryDlqStore.values()).filter(
      (j) => j.queueName === dlqJob.queueName && j.status === 'DEAD_LETTER'
    ).length;
    dlqCurrentGauge.set({ queue: dlqJob.queueName }, countForQueue);
  } catch {}

  logger.info({ jobId, queue: dlqJob.queueName, experimentId: dlqJob.experimentId }, '[DLQ] Job re-enqueued for retry');

  return {
    success: true,
    message: `Job ${jobId} successfully re-enqueued for retry`,
    job: { ...dlqJob, data: sanitizeDlqPayload(dlqJob.data) },
  };
}

/**
 * Retry all DLQ jobs across queues or for a specific queue (scoped to caller's projects when provided)
 */
export async function retryAllDlqJobs(
  queueName?: string,
  allowedProjectIds?: Set<string>,
  explicitProjectId?: string
): Promise<{ retriedCount: number; message: string }> {
  const allJobs = Array.from(inMemoryDlqStore.values()).filter(
    (j) => (!queueName || j.queueName.toLowerCase() === queueName.toLowerCase()) && j.status === 'DEAD_LETTER'
  );

  let retriedCount = 0;
  for (const job of allJobs) {
    if (!(await isDlqJobVisibleToTenant(job, allowedProjectIds, explicitProjectId))) {
      continue;
    }
    const result = await retryDlqJob(job.id);
    if (result.success) {
      retriedCount++;
    }
  }

  return {
    retriedCount,
    message: `Successfully triggered retry for ${retriedCount} DLQ job(s)`,
  };
}

/**
 * Discard / purge a single DLQ job
 */
export async function discardDlqJob(jobId: string): Promise<{ success: boolean; message: string }> {
  const dlqJob = inMemoryDlqStore.get(jobId);
  if (!dlqJob) {
    return { success: false, message: `DLQ Job ${jobId} not found` };
  }

  inMemoryDlqStore.delete(jobId);

  try {
    const countForQueue = Array.from(inMemoryDlqStore.values()).filter(
      (j) => j.queueName === dlqJob.queueName && j.status === 'DEAD_LETTER'
    ).length;
    dlqCurrentGauge.set({ queue: dlqJob.queueName }, countForQueue);
  } catch {}

  logger.info({ jobId, queue: dlqJob.queueName }, '[DLQ] Job discarded from Dead-Letter Queue');

  return { success: true, message: `Job ${jobId} discarded from DLQ` };
}

/**
 * Purge all DLQ jobs (scoped to caller's projects when provided)
 */
export async function purgeAllDlqJobs(
  queueName?: string,
  allowedProjectIds?: Set<string>,
  explicitProjectId?: string
): Promise<{ purgedCount: number; message: string }> {
  let purgedCount = 0;

  for (const [id, job] of inMemoryDlqStore.entries()) {
    if (queueName && job.queueName.toLowerCase() !== queueName.toLowerCase()) {
      continue;
    }
    if (!(await isDlqJobVisibleToTenant(job, allowedProjectIds, explicitProjectId))) {
      continue;
    }
    inMemoryDlqStore.delete(id);
    purgedCount++;
  }

  try {
    for (const q of registeredQueues.keys()) {
      const countForQueue = Array.from(inMemoryDlqStore.values()).filter(
        (j) => j.queueName === q && j.status === 'DEAD_LETTER'
      ).length;
      dlqCurrentGauge.set({ queue: q }, countForQueue);
    }
  } catch {}

  logger.info({ purgedCount, queueName: queueName || 'ALL' }, '[DLQ] Purged Dead-Letter Queue jobs');

  return { purgedCount, message: `Purged ${purgedCount} DLQ job(s)` };
}

/**
 * Get aggregate statistics across BullMQ queues and DLQ
 */
export async function getQueueStats(
  allowedProjectIds?: Set<string>,
  explicitProjectId?: string
): Promise<{
  dlqTotal: number;
  dlqByQueue: Record<string, number>;
  queues: QueueHealthStats[];
}> {
  let dlqTotal = 0;
  const dlqByQueue: Record<string, number> = {};

  for (const job of inMemoryDlqStore.values()) {
    if (job.status === 'DEAD_LETTER' && (await isDlqJobVisibleToTenant(job, allowedProjectIds, explicitProjectId))) {
      dlqTotal++;
      dlqByQueue[job.queueName] = (dlqByQueue[job.queueName] || 0) + 1;
    }
  }

  const queueStats: QueueHealthStats[] = [];
  const allQueueNames = new Set<string>([...registeredQueues.keys(), 'experiments', 'cleanup', 'telemetry']);

  for (const qName of allQueueNames) {
    const queue = registeredQueues.get(qName);
    let waiting = 0;
    let active = 0;
    let completed = 0;
    let failed = dlqByQueue[qName] || 0;
    let delayed = 0;
    let paused = false;

    if (queue && !allowedProjectIds && !explicitProjectId) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
        waiting = counts.waiting || 0;
        active = counts.active || 0;
        completed = counts.completed || 0;
        failed = Math.max(failed, counts.failed || 0);
        delayed = counts.delayed || 0;
        try {
          paused = await queue.isPaused();
        } catch {
          paused = false;
        }
      } catch {
        // Degraded/mock mode counts fallback
      }
    }

    queueStats.push({
      queueName: qName,
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused,
    });
  }

  return {
    dlqTotal,
    dlqByQueue,
    queues: queueStats,
  };
}

/**
 * Helper for testing to retrieve all DLQ records
 */
export function getDlqRecords(): DlqJobRecord[] {
  return Array.from(inMemoryDlqStore.values());
}

/**
 * Helper for testing to clear DLQ store for a specific queue
 */
export function clearDlqForQueue(queueName?: string): void {
  if (!queueName) {
    inMemoryDlqStore.clear();
    return;
  }
  for (const [id, job] of inMemoryDlqStore.entries()) {
    if (job.queueName.toLowerCase() === queueName.toLowerCase()) {
      inMemoryDlqStore.delete(id);
    }
  }
}

/**
 * Helper for testing to clear DLQ store
 */
export function __clearDlqStoreForTests() {
  inMemoryDlqStore.clear();
}
