import { redisConnection, isManagedServerlessRedis } from './redis.js';
import { db } from './db/index.js';
import { metricLogs, securityEvents } from './db/schema.js';
import { logger } from './lib/logger.js';
import { METRICS_STREAM_KEY, SECURITY_EVENTS_STREAM_KEY } from './lib/telemetry.js';

const CONSUMER_GROUP = 'fortix:telemetry_group';
const CONSUMER_NAME = process.env.HOSTNAME || 'worker-' + process.pid;
const BATCH_SIZE = 100;
const BLOCK_TIMEOUT_MS = isManagedServerlessRedis ? 5000 : 2000;
const IDLE_SLEEP_MS = isManagedServerlessRedis ? 20000 : 1000;

let isRunning = true;

async function setupConsumerGroup(streamKey: string) {
  try {
    await redisConnection.xgroup('CREATE', streamKey, CONSUMER_GROUP, '$', 'MKSTREAM');
    logger.info(`Created consumer group for ${streamKey}`);
  } catch (err: any) {
    if (err?.message && (err.message.includes('BUSYGROUP') || err.message.includes('already exists'))) {
      return;
    }
    try {
      const exists = await redisConnection.exists(streamKey);
      if (!exists) {
        await redisConnection.xadd(streamKey, '*', 'init', '1');
      }
      await redisConnection.xgroup('CREATE', streamKey, CONSUMER_GROUP, '$');
    } catch (e: any) {
      if (!e?.message?.includes('BUSYGROUP') && !e?.message?.includes('already exists')) {
        logger.warn({ err: e }, `Could not create consumer group for ${streamKey}`);
      }
    }
  }
}

async function processPending(streamKey: string, table: any) {
  try {
    const res = await redisConnection.xreadgroup(
      'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
      'COUNT', BATCH_SIZE,
      'STREAMS', streamKey,
      '0' // '0' means read pending messages for this consumer
    );
    if (res && res.length > 0) {
      const entries = (res as any)[0][1];
      if (entries.length > 0) {
        await processBatch(streamKey, table, entries);
      }
    }
  } catch (err: any) {
    if (err?.message && (err.message.includes('NOGROUP') || err.message.includes('no such key'))) {
      await setupConsumerGroup(streamKey);
    } else {
      logger.error({ err }, `Error processing pending for ${streamKey}`);
    }
  }
}

async function processBatch(streamKey: string, table: any, entries: any[]) {
  const records = [];
  const idsToAck = [];

  for (const entry of entries) {
    const streamId = entry[0];
    const fields = entry[1];
    
    // Convert array of fields ['data', '{"a":1}'] into object
    let dataStr = null;
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'data') {
        dataStr = fields[i + 1];
        break;
      }
    }

    if (dataStr) {
      try {
        const raw = JSON.parse(dataStr);
        let normalized = raw;
        if (table === securityEvents) {
          normalized = {
            id: raw.id,
            routeId: raw.routeId,
            requestId: raw.requestId || null,
            threatType: raw.threatType || raw.type || 'SUSPICIOUS_ACTIVITY',
            payload: raw.payload || {
              severity: raw.severity || 'HIGH',
              action: raw.action || 'BLOCKED',
              sourceIp: raw.sourceIp || 'unknown'
            },
            timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date()
          };
        } else if (raw.timestamp && typeof raw.timestamp === 'string') {
          normalized.timestamp = new Date(raw.timestamp);
        }
        records.push(normalized);
      } catch (e) {
        logger.error({ streamId }, 'Malformed telemetry data, skipping');
      }
    }
    idsToAck.push(streamId);
  }

  if (records.length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(table).values(records).onConflictDoNothing().execute();
    });
    logger.debug({ count: records.length, streamKey }, `Flushed telemetry to DB`);
  }

  if (idsToAck.length > 0) {
    await redisConnection.xack(streamKey, CONSUMER_GROUP, ...idsToAck);
  }
}

export async function processTelemetryBatch() {
  logger.info('Telemetry worker started');

  await setupConsumerGroup(METRICS_STREAM_KEY);
  await setupConsumerGroup(SECURITY_EVENTS_STREAM_KEY);

  // Initial pending recovery
  await processPending(METRICS_STREAM_KEY, metricLogs);
  await processPending(SECURITY_EVENTS_STREAM_KEY, securityEvents);

  while (isRunning) {
    try {
      // We can use XREADGROUP to read from both streams blocking
      const res = await redisConnection.xreadgroup(
        'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_TIMEOUT_MS,
        'STREAMS', METRICS_STREAM_KEY, SECURITY_EVENTS_STREAM_KEY,
        '>', '>'
      );

      let hadEntries = false;
      if (res && Array.isArray(res) && res.length > 0) {
        for (const streamRes of res as any) {
          const streamKey = streamRes[0];
          const entries = streamRes[1];
          if (entries && entries.length > 0) {
            hadEntries = true;
            const table = streamKey === METRICS_STREAM_KEY ? metricLogs : securityEvents;
            await processBatch(streamKey, table, entries);
          }
        }
      }

      if (!hadEntries && isRunning) {
        // Yield/sleep when no items to prevent tight loop or exhausting serverless Redis command quotas
        await new Promise(resolve => setTimeout(resolve, IDLE_SLEEP_MS));
      }
    } catch (err: any) {
      const errMsg = err?.message || '';
      if (errMsg.includes('NOGROUP') || errMsg.includes('no such key')) {
        logger.warn('Consumer group or stream missing (NOGROUP). Re-creating consumer groups...');
        await setupConsumerGroup(METRICS_STREAM_KEY);
        await setupConsumerGroup(SECURITY_EVENTS_STREAM_KEY);
      } else if (
        errMsg.includes('ECONNREFUSED') || 
        errMsg.includes('NR_CLOSED') || 
        errMsg.includes('EAI_AGAIN') || 
        errMsg.includes('getaddrinfo') || 
        errMsg.includes('ENOTFOUND')
      ) {
        // Connection temporarily lost or resolving, will auto-reconnect
      } else {
        logger.error({ err }, 'Error processing telemetry batch');
      }
      // Prevent tight loop on error
      if (isRunning) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  logger.info('Telemetry worker stopped');
}

export function stopWorker() {
  isRunning = false;
}
