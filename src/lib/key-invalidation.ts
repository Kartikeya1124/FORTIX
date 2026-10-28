import Redis from 'ioredis';
import { z } from 'zod';
import { exec, execSync } from 'child_process';
import { logger } from './logger.js';
import { invalidateApiKeyCache } from '../gateway/index.js';
import { sharedRedisMock, resolvedRedisUrl, isRealRedisActive } from '../redis.js';

import { apiKeyCacheInvalidationsTotal } from './metrics.js';

export const REDIS_KEY_REVOCATION_CHANNEL = 'fortix:api-key:revoked:v1';

export const keyRevocationEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('api_key.revoked'),
    keyId: z.string().min(1),
    projectId: z.string().min(1),
    timestamp: z.string(),
    reason: z.string().optional()
  }),
  z.object({
    event: z.literal('api_key.revoked_all'),
    projectId: z.string().min(1),
    timestamp: z.string()
  })
]);

export type KeyRevocationEvent = z.infer<typeof keyRevocationEventSchema>;

const redisUrl = resolvedRedisUrl;
const isTls = redisUrl.startsWith('rediss://');

// Dedicated publisher and subscriber clients
let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let isSubscriberInitialized = false;

export function getPublisher(): Redis {
  if (!publisherClient) {
    if (!isRealRedisActive && process.env.USE_REAL_REDIS !== 'true') {
      publisherClient = (sharedRedisMock as any).createConnectedClient 
        ? (sharedRedisMock as any).createConnectedClient() 
        : new (sharedRedisMock.constructor as any)();
      (publisherClient as any).status = 'ready';
      return publisherClient;
    }

    publisherClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      enableOfflineQueue: true,
      lazyConnect: false,
      connectTimeout: 10000,
      tls: isTls ? { rejectUnauthorized: false } : undefined,
      retryStrategy: (times) => Math.min(times * 250, 5000),
    });
    publisherClient.on('error', (err: any) => {
      const msg = String(err?.message || '');
      if (msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND')) {
        return;
      }
      logger.warn({ msg: '[KeyRevocation Publisher] Redis error', err: err.message });
    });
  }
  return publisherClient;
}

export async function publishKeyRevocation(event: KeyRevocationEvent): Promise<boolean> {
  try {
    const validated = keyRevocationEventSchema.parse(event);
    const pub = getPublisher();
    await pub.publish(REDIS_KEY_REVOCATION_CHANNEL, JSON.stringify(validated));
    logger.info({ msg: '[KeyRevocation] Published cache invalidation event', event: validated });
    return true;
  } catch (error: any) {
    logger.error({ msg: '[KeyRevocation] Failed to publish key revocation', error: error.message });
    return false;
  }
}

export function setupKeyRevocationSubscriber(customInvalidate?: (keyId?: string, projectId?: string) => void): Redis {
  if (subscriberClient && isSubscriberInitialized) {
    return subscriberClient;
  }

  const invalidate = customInvalidate || invalidateApiKeyCache;

  if (!isRealRedisActive && process.env.USE_REAL_REDIS !== 'true') {
    const sub = (sharedRedisMock as any).createConnectedClient 
      ? (sharedRedisMock as any).createConnectedClient() 
      : sharedRedisMock;
    (sub as any).status = 'ready';
    subscriberClient = sub as any;

    subscriberClient!.on('message', (channel: string, message: string) => {
      if (channel !== REDIS_KEY_REVOCATION_CHANNEL) return;
      try {
        const parsedJson = JSON.parse(message);
        const parseResult = keyRevocationEventSchema.safeParse(parsedJson);
        if (!parseResult.success) return;

        const event = parseResult.data;
        if (event.event === 'api_key.revoked') {
          invalidate(event.keyId, event.projectId);
          apiKeyCacheInvalidationsTotal.inc({ source: 'redis_pubsub', event_type: 'api_key.revoked' });
        } else if (event.event === 'api_key.revoked_all') {
          invalidate(undefined, event.projectId);
          apiKeyCacheInvalidationsTotal.inc({ source: 'redis_pubsub', event_type: 'api_key.revoked_all' });
        }
      } catch {}
    });

    subscriberClient!.subscribe(REDIS_KEY_REVOCATION_CHANNEL).catch(() => {});
    isSubscriberInitialized = true;
    return subscriberClient!;
  }

  subscriberClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    lazyConnect: false,
    connectTimeout: 10000,
    tls: isTls ? { rejectUnauthorized: false } : undefined,
    retryStrategy: (times) => Math.min(times * 250, 5000),
  });

  subscriberClient.on('error', (err: any) => {
    const msg = String(err?.message || '');
    if (msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND')) {
      return;
    }
    logger.warn({ msg: '[KeyRevocation Subscriber] Redis error', err: err.message });
  });

  // On reconnect, purge in-memory cache to guarantee no missed revocations during disconnection
  subscriberClient.on('ready', () => {
    logger.info({ msg: '[KeyRevocation Subscriber] Redis connection ready, purging local cache to prevent stale keys' });
    invalidate();
    subscriberClient?.subscribe(REDIS_KEY_REVOCATION_CHANNEL, (err) => {
      if (err) {
        logger.error({ msg: '[KeyRevocation Subscriber] Failed to subscribe to channel', err: err.message });
      } else {
        logger.info({ msg: '[KeyRevocation Subscriber] Subscribed to channel', channel: REDIS_KEY_REVOCATION_CHANNEL });
      }
    });
  });

  subscriberClient.on('message', (channel, message) => {
    if (channel !== REDIS_KEY_REVOCATION_CHANNEL) return;

    try {
      const parsedJson = JSON.parse(message);
      const parseResult = keyRevocationEventSchema.safeParse(parsedJson);

      if (!parseResult.success) {
        logger.warn({ msg: '[KeyRevocation Subscriber] Discarding invalid payload', error: parseResult.error });
        return;
      }

      const event = parseResult.data;
      if (event.event === 'api_key.revoked') {
        invalidate(event.keyId, event.projectId);
        apiKeyCacheInvalidationsTotal.inc({ source: 'redis_pubsub', event_type: 'api_key.revoked' });
        logger.info({ msg: '[KeyRevocation Subscriber] Invalidated keyId from cache', keyId: event.keyId, projectId: event.projectId });
      } else if (event.event === 'api_key.revoked_all') {
        invalidate(undefined, event.projectId);
        apiKeyCacheInvalidationsTotal.inc({ source: 'redis_pubsub', event_type: 'api_key.revoked_all' });
        logger.info({ msg: '[KeyRevocation Subscriber] Invalidated all keys for projectId from cache', projectId: event.projectId });
      }
    } catch (err: any) {
      logger.warn({ msg: '[KeyRevocation Subscriber] JSON parse failed on revocation event', err: err.message });
    }
  });

  isSubscriberInitialized = true;
  return subscriberClient;
}

export async function closeKeyRevocationClients(): Promise<void> {
  if (subscriberClient) {
    try {
      await subscriberClient.quit();
    } catch {}
    subscriberClient = null;
    isSubscriberInitialized = false;
  }
  if (publisherClient) {
    try {
      await publisherClient.quit();
    } catch {}
    publisherClient = null;
  }
}
