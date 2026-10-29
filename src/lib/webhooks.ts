import { Queue } from 'bullmq';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { webhooks, webhookDeliveries } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { redisConnection, isRealRedisActive, getBullMqConnectionOptions } from '../redis.js';
import { registerQueue, recordDlqFailure } from './dlq.js';
import { logger } from './logger.js';
import { securityGuard } from '../services/SecurityGuard.js';

export interface WebhookJobData {
  deliveryId?: string;
  webhookId: string;
  projectId: string;
  url: string;
  secret?: string | null;
  eventType: string;
  payload: Record<string, any>;
  attemptNumber?: number;
  maxAttempts?: number;
}

export interface WebhookDeliveryRecord {
  id: string;
  webhookId: string;
  projectId: string;
  eventType: string;
  payload: Record<string, any>;
  attemptNumber: number;
  maxAttempts: number;
  statusCode?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  success: boolean;
  signature?: string | null;
  createdAt: string;
}

// In-memory fallback delivery store for fast local lookups and tests
export const inMemoryWebhookDeliveries: WebhookDeliveryRecord[] = [];

export const DEFAULT_WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000, // 1s, 2s, 4s, 8s, 16s
  },
  timeout: 10000, // 10s HTTP timeout
  removeOnComplete: {
    count: 200,
    age: 86400,
  },
  removeOnFail: false,
};

// Initialize BullMQ webhook queue
export const webhookQueue = new Queue('fortix-webhooks', {
  connection: (isRealRedisActive ? getBullMqConnectionOptions() : redisConnection) as any,
});

registerQueue('fortix-webhooks', webhookQueue);

webhookQueue.on('error', (err: any) => {
  const msg = String(err?.message || '');
  if (msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND')) return;
  logger.error({ err }, '[BullMQ fortix-webhooks queue] Error');
});

/**
 * Generates an HMAC-SHA256 signature for a webhook payload.
 * Format: t=<timestamp>,v1=<hexSignature>
 */
export function generateWebhookSignature(
  payload: string | Record<string, any>,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): { signatureHeader: string; signatureHex: string; timestamp: number } {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signedPayload = `${timestamp}.${serialized}`;
  const signatureHex = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  const signatureHeader = `t=${timestamp},v1=${signatureHex}`;

  return { signatureHeader, signatureHex, timestamp };
}

/**
 * Verifies an HMAC-SHA256 signature against the given payload.
 * Strictly requires a positive integer timestamp within the replay tolerance window.
 */
export function verifyWebhookSignature(
  payload: string | Record<string, any>,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): { valid: boolean; reason?: string } {
  if (!signatureHeader || !secret) {
    return { valid: false, reason: 'Missing signature header or secret' };
  }

  const parts = signatureHeader.split(',').map((p) => p.trim());
  let timestampStr: string | null = null;
  let signatureHex: string | null = null;

  for (const part of parts) {
    if (part.startsWith('t=')) {
      timestampStr = part.slice(2);
    } else if (part.startsWith('v1=')) {
      signatureHex = part.slice(3);
    } else if (part.startsWith('sha256=')) {
      signatureHex = part.slice(7);
    }
  }

  if (!signatureHex || !/^[a-f0-9]{64}$/i.test(signatureHex)) {
    return { valid: false, reason: 'Invalid signature header format' };
  }

  if (!timestampStr || !/^\d+$/.test(timestampStr)) {
    return { valid: false, reason: 'Missing or invalid signature timestamp' };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { valid: false, reason: 'Missing or invalid signature timestamp' };
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTimestamp - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'Timestamp outside allowable tolerance window' };
  }

  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signedPayload = `${timestamp}.${serialized}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const receivedBuffer = Buffer.from(signatureHex.toLowerCase(), 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return { valid: false, reason: 'Signature length mismatch' };
  }

  const matches = crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  return { valid: matches, reason: matches ? undefined : 'HMAC signature verification failed' };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_WEBHOOK_REDIRECTS = 3;

async function resolveSigningSecret(jobData: WebhookJobData): Promise<string | null> {
  if (jobData.secret && jobData.secret !== '[REDACTED]') {
    return jobData.secret;
  }
  if (!jobData.webhookId || !jobData.projectId) {
    return null;
  }
  try {
    const [wh] = await db
      .select({ secret: webhooks.secret })
      .from(webhooks)
      .where(and(eq(webhooks.id, jobData.webhookId), eq(webhooks.projectId, jobData.projectId)))
      .limit(1);
    return wh?.secret || null;
  } catch {
    return null;
  }
}

/**
 * Executes a single HTTP webhook delivery attempt with SSRF security checks
 * (including manual redirect validation to block 302/307 SSRF),
 * response capturing, and persistent delivery audit logging.
 */
export async function executeWebhookDelivery(
  jobData: WebhookJobData,
  attemptNumber: number = 1
): Promise<{ success: boolean; statusCode?: number; responseBody?: string }> {
  const deliveryId = jobData.deliveryId || uuidv4();
  const maxAttempts = jobData.maxAttempts ?? 5;
  const startTime = Date.now();

  // 1. Strict SSRF check before making HTTP request (disallow internal demo API on webhooks)
  const ssrfCheck = await securityGuard.validateTarget(jobData.url, { allowDemoApi: false });
  if (!ssrfCheck.isValid) {
    const errorMsg = `SSRF blocked webhook URL: ${ssrfCheck.reason || 'Restricted target'}`;
    const record: WebhookDeliveryRecord = {
      id: deliveryId,
      webhookId: jobData.webhookId,
      projectId: jobData.projectId,
      eventType: jobData.eventType,
      payload: jobData.payload,
      attemptNumber,
      maxAttempts,
      statusCode: 400,
      errorMessage: errorMsg,
      latencyMs: Date.now() - startTime,
      success: false,
      createdAt: new Date().toISOString(),
    };
    await recordDeliveryInDb(record);
    throw new Error(errorMsg);
  }

  // 2. Prepare payload & HMAC signature
  const timestamp = Math.floor(Date.now() / 1000);
  const serializedBody = JSON.stringify(jobData.payload);
  let signatureHeader = '';
  const signingSecret = await resolveSigningSecret(jobData);
  if (signingSecret) {
    const sig = generateWebhookSignature(serializedBody, signingSecret, timestamp);
    signatureHeader = sig.signatureHeader;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'FortiX-Webhook-Engine/1.0',
    'X-FortiX-Delivery': deliveryId,
    'X-FortiX-Event': jobData.eventType,
    'X-FortiX-Timestamp': String(timestamp),
    'X-FortiX-Attempt': String(attemptNumber),
    'X-FortiX-Max-Attempts': String(maxAttempts),
  };

  if (signatureHeader) {
    headers['X-FortiX-Signature-256'] = signatureHeader;
  }

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let success = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      let currentUrl = jobData.url;
      let response: any = null;

      for (let hop = 0; hop <= MAX_WEBHOOK_REDIRECTS; hop++) {
        response = await fetch(currentUrl, {
          method: 'POST',
          headers,
          body: serializedBody,
          redirect: 'manual',
          signal: controller.signal,
        });

        if (REDIRECT_STATUSES.has(response.status)) {
          const locationHeader = response.headers?.get?.('location');
          if (!locationHeader) {
            statusCode = response.status;
            errorMessage = `Webhook endpoint returned redirect HTTP ${response.status} without Location header`;
            break;
          }
          if (hop >= MAX_WEBHOOK_REDIRECTS) {
            statusCode = response.status;
            errorMessage = `Webhook exceeded maximum redirect limit (${MAX_WEBHOOK_REDIRECTS})`;
            break;
          }

          let nextUrl: string;
          try {
            nextUrl = new URL(locationHeader, currentUrl).toString();
          } catch {
            statusCode = 400;
            errorMessage = 'SSRF blocked webhook redirect: Malformed redirect Location URL';
            break;
          }

          const redirectCheck = await securityGuard.validateTarget(nextUrl, { allowDemoApi: false });
          if (!redirectCheck.isValid) {
            statusCode = 400;
            errorMessage = `SSRF blocked webhook redirect: ${redirectCheck.reason || 'Restricted redirect target'}`;
            break;
          }

          currentUrl = nextUrl;
          continue;
        }

        statusCode = response.status;
        const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
        responseBody = text.slice(0, 2048);

        if (response.ok) {
          success = true;
        } else {
          errorMessage = `Webhook endpoint returned HTTP ${statusCode}`;
        }
        break;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (fetchErr: any) {
    if (fetchErr?.name === 'AbortError') {
      errorMessage = 'Webhook request timed out after 10000ms';
    } else {
      errorMessage = fetchErr?.message || 'Network error during webhook dispatch';
    }
  }

  const latencyMs = Date.now() - startTime;
  const deliveryRecord: WebhookDeliveryRecord = {
    id: deliveryId,
    webhookId: jobData.webhookId,
    projectId: jobData.projectId,
    eventType: jobData.eventType,
    payload: jobData.payload,
    attemptNumber,
    maxAttempts,
    statusCode,
    responseBody,
    errorMessage,
    latencyMs,
    success,
    signature: signatureHeader || null,
    createdAt: new Date().toISOString(),
  };

  await recordDeliveryInDb(deliveryRecord);

  if (!success) {
    throw new Error(errorMessage || `Webhook delivery failed with HTTP ${statusCode}`);
  }

  return { success: true, statusCode: statusCode ?? 200, responseBody: responseBody ?? '' };
}

/**
 * Persists webhook delivery record to PostgreSQL and in-memory cache.
 */
async function recordDeliveryInDb(record: WebhookDeliveryRecord): Promise<void> {
  inMemoryWebhookDeliveries.unshift(record);
  if (inMemoryWebhookDeliveries.length > 500) {
    inMemoryWebhookDeliveries.pop();
  }

  try {
    await db.insert(webhookDeliveries).values({
      id: record.id,
      webhookId: record.webhookId,
      projectId: record.projectId,
      eventType: record.eventType,
      payload: record.payload,
      attemptNumber: record.attemptNumber,
      maxAttempts: record.maxAttempts,
      statusCode: record.statusCode,
      responseBody: record.responseBody,
      errorMessage: record.errorMessage,
      latencyMs: record.latencyMs,
      success: record.success,
      signature: record.signature,
      createdAt: new Date(record.createdAt),
    });
  } catch (dbErr) {
    logger.debug({ err: dbErr }, '[Webhooks] Failed to persist webhook delivery in Postgres, stored in memory.');
  }
}

function dispatchFallbackWebhookRunner(deliveryId: string, jobData: WebhookJobData) {
  setTimeout(async () => {
    let currentAttempt = 1;
    const maxAttempts = jobData.maxAttempts ?? 5;
    while (currentAttempt <= maxAttempts) {
      try {
        await executeWebhookDelivery(jobData, currentAttempt);
        break;
      } catch (err: any) {
        if (currentAttempt >= maxAttempts) {
          await recordDlqFailure({
            jobId: deliveryId,
            queueName: 'fortix-webhooks',
            jobName: 'deliver-webhook',
            data: { ...jobData, secret: jobData.secret ? '[REDACTED]' : null },
            failedReason: err?.message || 'Webhook delivery failed after 5 exponential attempts',
            stacktrace: err?.stack ? [err.stack] : [],
            attemptsMade: maxAttempts,
            maxAttempts,
          });
        }
        currentAttempt++;
      }
    }
  }, 50);
}

/**
 * Enqueues a webhook event across all active webhooks subscribed to this project and event type.
 */
export async function enqueueWebhookEvent(
  projectId: string,
  eventType: string,
  eventData: Record<string, any>
): Promise<string[]> {
  try {
    const list = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.projectId, projectId), eq(webhooks.isActive, true)));

    const matching = list.filter((wh) => {
      if (!wh.events) return false;
      const evs = Array.isArray(wh.events) ? wh.events : [wh.events];
      return evs.includes('*') || evs.includes(eventType) || evs.some((e: any) => String(e).toLowerCase() === eventType.toLowerCase());
    });

    const jobIds: string[] = [];
    for (const wh of matching) {
      const deliveryId = uuidv4();
      const jobData: WebhookJobData = {
        deliveryId,
        webhookId: wh.id,
        projectId: wh.projectId,
        url: wh.url,
        secret: wh.secret,
        eventType,
        payload: {
          event: eventType,
          timestamp: new Date().toISOString(),
          projectId,
          data: eventData,
        },
        maxAttempts: 5,
      };

      if (!isRealRedisActive) {
        dispatchFallbackWebhookRunner(deliveryId, jobData);
        jobIds.push(deliveryId);
        continue;
      }

      try {
        const job = await webhookQueue.add('deliver-webhook', jobData, DEFAULT_WEBHOOK_JOB_OPTIONS);
        if (job?.id) jobIds.push(job.id);
      } catch (queueErr) {
        logger.warn({ err: queueErr }, '[Webhooks] BullMQ add failed, executing via fallback runner');
        dispatchFallbackWebhookRunner(deliveryId, jobData);
        jobIds.push(deliveryId);
      }
    }

    return jobIds;
  } catch (error) {
    logger.error({ err: error, projectId, eventType }, '[Webhooks] Error querying webhooks for event');
    return [];
  }
}
