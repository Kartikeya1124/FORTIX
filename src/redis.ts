import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import * as dotenv from 'dotenv';
import { exec, execSync } from 'child_process';
dotenv.config({ override: true });

// Ensure redis-server daemon is running locally if binary exists
let isRedisDaemonRunning = false;
try {
  execSync('redis-cli ping >/dev/null 2>&1 || (which redis-server >/dev/null 2>&1 && redis-server --daemonize yes)', { timeout: 2000 });
  isRedisDaemonRunning = true;
} catch (e) {
  isRedisDaemonRunning = false;
}

const rawRedisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
// Filter out unresolvable private cloud internal hostnames (e.g., Render internal 'red-...') outside their VPC
const isRenderInternal = rawRedisUrl.includes('red-') && !rawRedisUrl.includes('.render.com');
const redisUrl = isRenderInternal ? 'redis://127.0.0.1:6379' : rawRedisUrl;

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
  if (isRedisDaemonRunning || process.env.USE_REAL_REDIS === 'true') {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      lazyConnect: false,
      connectTimeout: 3000,
      retryStrategy(times: number) {
        if (times % 5 === 0) {
          try {
            exec('which redis-server >/dev/null 2>&1 && redis-server --daemonize yes', () => {});
          } catch (e) {}
        }
        return Math.min(times * 100, 2000);
      }
    });

    client.on('error', (err: any) => {
      const msg = err?.message || '';
      const code = err?.code || '';
      if (
        code === 'ECONNREFUSED' ||
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'ETIMEDOUT' ||
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



