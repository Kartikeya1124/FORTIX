import { redisConnection } from '../redis.js';
import { db } from '../db/index.js';
import { metricLogs, securityEvents } from '../db/schema.js';
import { logger } from './logger.js';

export const METRICS_STREAM_KEY = 'fortix:stream:metrics';
export const SECURITY_EVENTS_STREAM_KEY = 'fortix:stream:security';
const MAX_LEN = 10000;

export async function enqueueMetric(metric: any) {
  try {
    if (redisConnection && typeof (redisConnection as any).xadd === 'function') {
      await redisConnection.xadd(METRICS_STREAM_KEY, 'MAXLEN', '~', MAX_LEN, '*', 'data', JSON.stringify(metric));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to enqueue metric to Redis stream');
  }

  // Dual-write fallback ensures real telemetry persistence even when dedicated consumer worker is dormant
  try {
    await db.insert(metricLogs).values({
      id: metric.id,
      routeId: metric.routeId,
      experimentId: metric.experimentId || null,
      requestId: metric.requestId || null,
      latencyMs: metric.latencyMs,
      statusCode: metric.statusCode,
      timestamp: new Date(),
    });
  } catch (dbErr) {
    // If telemetry worker already inserted or constraint duplicate, safely ignore
  }
}

export async function enqueueSecurityEvent(event: any) {
  try {
    if (redisConnection && typeof (redisConnection as any).xadd === 'function') {
      await redisConnection.xadd(SECURITY_EVENTS_STREAM_KEY, 'MAXLEN', '~', MAX_LEN, '*', 'data', JSON.stringify(event));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to enqueue security event to Redis stream');
  }

  // Dual-write fallback ensures security events are reliably logged in database
  try {
    await db.insert(securityEvents).values({
      id: event.id,
      routeId: event.routeId,
      requestId: event.requestId || null,
      threatType: event.type,
      payload: event,
      timestamp: new Date(),
    });
  } catch (dbErr) {
    // safely ignore
  }
}
