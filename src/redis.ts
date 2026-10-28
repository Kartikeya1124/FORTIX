import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import * as dotenv from 'dotenv';
import { exec, execSync } from 'child_process';
dotenv.config({ override: true });

export function normalizeRedisUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  let trimmed = rawUrl.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// Ensure redis-server daemon is running locally if binary exists
let isRedisDaemonRunning = false;
try {
  execSync('redis-cli ping >/dev/null 2>&1 || (which redis-server >/dev/null 2>&1 && redis-server --daemonize yes)', { timeout: 2000 });
  isRedisDaemonRunning = true;
} catch {
  isRedisDaemonRunning = false;
}

const configuredRedisUrl = normalizeRedisUrl(process.env.REDIS_URL);
const rawRedisUrl = configuredRedisUrl || 'redis://127.0.0.1:6379';
// Filter out unresolvable private cloud internal hostnames (e.g., Render internal 'red-...') outside their VPC
const isRenderInternal = rawRedisUrl.includes('red-') && !rawRedisUrl.includes('.render.com');
export const resolvedRedisUrl = isRenderInternal ? 'redis://127.0.0.1:6379' : rawRedisUrl;

function isLocalhostRedisUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const h = parsed.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return urlStr.includes('localhost') || urlStr.includes('127.0.0.1');
  }
}

const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
const hasConfiguredRemoteRedis =
  Boolean(configuredRedisUrl) &&
  !isRenderInternal &&
  !isLocalhostRedisUrl(resolvedRedisUrl) &&
  process.env.FORCE_IN_MEMORY_REDIS !== 'true';

export const isRealRedisActive: boolean =
  process.env.USE_REAL_REDIS === 'true' ||
  (!isTestEnv && (isRedisDaemonRunning || hasConfiguredRemoteRedis));

export const isManagedServerlessRedis: boolean =
  isRealRedisActive && resolvedRedisUrl.toLowerCase().includes('upstash.io');

export function getRedisStorageMode(): 'persistent' | 'in-memory' {
  return isRealRedisActive ? 'persistent' : 'in-memory';
}

export function getBullMqConnectionOptions() {
  if (configuredRedisUrl && !isRenderInternal) {
    try {
      const url = new URL(resolvedRedisUrl);
      const isTls = url.protocol === 'rediss:';
      return {
        host: url.hostname || '127.0.0.1',
        port: parseInt(url.port || '6379', 10),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: url.pathname && url.pathname.length > 1 ? parseInt(url.pathname.slice(1), 10) : 0,
        tls: isTls ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        enableOfflineQueue: true,
        connectTimeout: 10000,
        retryStrategy(times: number) {
          return Math.min(times * 1000, 15000);
        },
      };
    } catch {
      // fall through to host/port config
    }
  }
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy(times: number) {
      return Math.min(times * 1000, 15000);
    },
  };
}

// Shared in-memory mock instance for fallback
const sharedMock = new RedisMock();
(sharedMock as any).status = 'ready';

const inMemoryStreams = new Map<string, Array<{ id: string; fields: string[] }>>();
let streamSeq = 0;

(sharedMock as any).xadd = async (key: string, ...args: any[]) => {
  let stream = inMemoryStreams.get(key);
  if (!stream) {
    stream = [];
    inMemoryStreams.set(key, stream);
  }
  const id = `${Date.now()}-${++streamSeq}`;
  const dataIdx = args.indexOf('data');
  let fields: string[] = [];
  if (dataIdx !== -1 && dataIdx + 1 < args.length) {
    fields = ['data', args[dataIdx + 1]];
  } else {
    fields = ['data', JSON.stringify(args[args.length - 1] || {})];
  }
  stream.push({ id, fields });
  if (stream.length > 5000) stream.splice(0, stream.length - 5000);
  return id;
};

(sharedMock as any).xgroup = async () => 'OK';

(sharedMock as any).xreadgroup = async (
  groupKeyword: string,
  group: string,
  consumer: string,
  countKeyword: string,
  count: number,
  blockOrStreams: string,
  ...rest: any[]
) => {
  const allArgs = [groupKeyword, group, consumer, countKeyword, count, blockOrStreams, ...rest];
  const streamsIdx = allArgs.indexOf('STREAMS');
  if (streamsIdx === -1) return null;

  const afterStreams = allArgs.slice(streamsIdx + 1);
  const half = Math.floor(afterStreams.length / 2);
  const keys = afterStreams.slice(0, half);

  const results: any[] = [];
  for (const key of keys) {
    const stream = inMemoryStreams.get(key);
    if (stream && stream.length > 0) {
      const batch = stream.splice(0, typeof count === 'number' ? count : 100);
      results.push([key, batch.map(e => [e.id, e.fields])]);
    }
  }
  return results.length > 0 ? results : null;
};

(sharedMock as any).xack = async () => 1;

function createRedisConnection(): Redis {
  if (isRealRedisActive) {
    const isTls = resolvedRedisUrl.startsWith('rediss://');
    const client = new Redis(resolvedRedisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: true,
      lazyConnect: false,
      connectTimeout: 10000,
      tls: isTls ? { rejectUnauthorized: false } : undefined,
      retryStrategy(times: number) {
        if (!hasConfiguredRemoteRedis && times % 5 === 0) {
          try {
            exec('which redis-server >/dev/null 2>&1 && redis-server --daemonize yes', () => {});
          } catch {}
        }
        return Math.min(times * 250, 5000);
      },
    });

    client.on('error', (err: any) => {
      const msg = err?.message || '';
      const code = err?.code || '';
      if (
        code === 'ECONNREFUSED' ||
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('EAI_AGAIN') ||
        msg.includes('getaddrinfo') ||
        msg.includes('ENOTFOUND')
      ) {
        return;
      }
      console.error('[Redis] Error:', err?.message || err);
    });

    return client;
  }

  return sharedMock as any;
}

// Shared Redis connection for BullMQ, Telemetry, and Rate Limiter
export const redisConnection: Redis = createRedisConnection();
export const sharedRedisMock = sharedMock;
