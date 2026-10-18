import { db } from '../db/index.js';
import { workflowRuns, apiKeys, experiments } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { invalidateExpCache, invalidateApiKeyCache } from '../gateway/index.js';
import { broadcast } from '../socket.js';

export type WorkflowStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export const TERMINAL_STATUSES: readonly WorkflowStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * Formal state transition table defining allowed source statuses for every target status.
 */
export const ALLOWED_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  QUEUED: [], // Initial state upon creation
  RUNNING: ['QUEUED'],
  VERIFYING: ['RUNNING'],
  RECOVERY_REQUIRED: ['RUNNING', 'VERIFYING', 'QUEUED'],
  COMPLETED: ['VERIFYING', 'RECOVERY_REQUIRED', 'RUNNING'],
  FAILED: ['QUEUED', 'RUNNING', 'VERIFYING', 'RECOVERY_REQUIRED'],
  CANCELLED: ['QUEUED', 'RUNNING', 'VERIFYING', 'RECOVERY_REQUIRED'],
};

export class InvalidStateTransitionError extends Error {
  constructor(public readonly runId: string, public readonly fromStatus: string, public readonly toStatus: string) {
    super(`Invalid workflow transition for run '${runId}': cannot transition from '${fromStatus}' to '${toStatus}'`);
    this.name = 'InvalidStateTransitionError';
  }
}

export interface TransitionOptions {
  extraUpdates?: Record<string, any>;
  timelineMessage?: string;
  timelineLevel?: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  timelineDetails?: Record<string, any>;
}

/**
 * Atomically and transactionally transitions a workflow run's status.
 * Guarantees idempotency (returns current record if already at target status)
 * and enforces strict transition validation against the state machine graph.
 */
export async function transitionWorkflowStatus(
  runId: string,
  targetStatus: WorkflowStatus,
  options: TransitionOptions = {}
) {
  const [current] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  if (!current) {
    throw new Error(`Workflow run '${runId}' not found`);
  }

  const currentStatus = current.status as WorkflowStatus;

  // Idempotent no-op: If already at targetStatus, return without duplicate side effects
  if (currentStatus === targetStatus) {
    return {
      run: current,
      transitioned: false,
      reason: 'already_at_target_status',
    };
  }

  // Terminal state protection: Terminal states (COMPLETED, FAILED, CANCELLED) cannot be transitioned out of
  if (TERMINAL_STATUSES.includes(currentStatus)) {
    throw new InvalidStateTransitionError(runId, currentStatus, targetStatus);
  }

  // Validate allowed transitions
  const allowedSources = ALLOWED_TRANSITIONS[targetStatus];
  if (!allowedSources.includes(currentStatus)) {
    throw new InvalidStateTransitionError(runId, currentStatus, targetStatus);
  }

  // Construct timeline entry
  const now = new Date();
  const timelineEntry = {
    timestamp: now.toISOString(),
    stage: targetStatus,
    level: options.timelineLevel || (targetStatus === 'FAILED' ? 'ERROR' : targetStatus === 'COMPLETED' ? 'SUCCESS' : 'INFO'),
    message: options.timelineMessage || `Status transitioned from ${currentStatus} to ${targetStatus}`,
    details: options.timelineDetails,
  };

  const updatedTimeline = Array.isArray(current.timeline)
    ? [...current.timeline, timelineEntry]
    : [timelineEntry];

  // Atomic update using optimistic concurrency constraint (matching both id and currentStatus)
  const [updated] = await db
    .update(workflowRuns)
    .set({
      status: targetStatus,
      timeline: updatedTimeline,
      updatedAt: now,
      ...(TERMINAL_STATUSES.includes(targetStatus) ? { completedAt: now } : {}),
      ...(options.extraUpdates || {}),
    })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, currentStatus)))
    .returning();

  if (!updated) {
    // If update failed due to concurrent modification, fetch current state
    const [latest] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return {
      run: latest || current,
      transitioned: false,
      reason: 'concurrent_modification_detected',
    };
  }

  // Broadcast state change to connected UI clients
  broadcast(updated.projectId, 'workflow:run:status', {
    runId,
    status: targetStatus,
    previousStatus: currentStatus,
    timestamp: now.toISOString(),
  });

  return {
    run: updated,
    transitioned: true,
  };
}

/**
 * Reconciles abandoned / orphaned workflow runs after an abrupt worker crash or server restart.
 * Any runs left in 'RUNNING' or 'VERIFYING' are safely moved to 'RECOVERY_REQUIRED'
 * and have lingering active experiments & ephemeral credentials revoked.
 */
export async function reconcileAbandonedRuns(): Promise<{
  reconciledCount: number;
  runIds: string[];
}> {
  const orphanedRuns = await db
    .select()
    .from(workflowRuns)
    .where(inArray(workflowRuns.status, ['RUNNING', 'VERIFYING']));

  if (orphanedRuns.length === 0) {
    return { reconciledCount: 0, runIds: [] };
  }

  const reconciledIds: string[] = [];

  for (const run of orphanedRuns) {
    try {
      await transitionWorkflowStatus(run.id, 'RECOVERY_REQUIRED', {
        timelineMessage: 'Process restart detected: Abandoned in-flight workflow reconciled into RECOVERY_REQUIRED. Executing fault cleanup.',
        timelineLevel: 'WARN',
        extraUpdates: {
          cleanupStatus: 'CLEANED',
          errorMessage: 'Execution interrupted by server/worker process restart',
        },
      });

      // Cleanup any active route experiments
      if (run.routeId) {
        invalidateExpCache(run.routeId);
        await db
          .update(experiments)
          .set({ status: 'COMPLETED', completedAt: new Date() })
          .where(and(eq(experiments.routeId, run.routeId), eq(experiments.status, 'RUNNING')));
      }

      // Cleanup ephemeral run keys
      await db
        .delete(apiKeys)
        .where(and(eq(apiKeys.projectId, run.projectId), eq(apiKeys.name, `Autonomous Run Worker (${run.id.slice(0, 10)})`)));

      reconciledIds.push(run.id);
    } catch (err) {
      console.error(`[StateMachine] Failed to reconcile abandoned run ${run.id}:`, err);
    }
  }

  return {
    reconciledCount: reconciledIds.length,
    runIds: reconciledIds,
  };
}
