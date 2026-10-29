import { redisConnection, isRealRedisActive } from "../redis.js";
import * as dotenv from 'dotenv';
import { db } from '../db/index.js';
import { securityPolicies } from '../db/schema.js';
import { eq } from 'drizzle-orm';

dotenv.config({ override: true });

const redis = redisConnection;

// Bounded local fallback store to prevent memory leaks and OOM under flood attacks
const MAX_FALLBACK_STORE_ENTRIES = 5000;
const FALLBACK_EXPIRATION_MS = 60000; // 60s TTL
const fallbackStore = new Map<string, { tokens: number, lastRefill: number }>();

function pruneFallbackStore() {
  const now = Date.now();
  for (const [k, v] of fallbackStore.entries()) {
    if (now - v.lastRefill > FALLBACK_EXPIRATION_MS) {
      fallbackStore.delete(k);
    }
  }
  // If still full, drop oldest 10% of entries
  if (fallbackStore.size >= MAX_FALLBACK_STORE_ENTRIES) {
    const keys = Array.from(fallbackStore.keys());
    const dropCount = Math.ceil(keys.length * 0.1);
    for (let i = 0; i < dropCount; i++) {
      fallbackStore.delete(keys[i]);
    }
  }
}

export const VALID_REDIS_FAILURE_POLICIES = ['fail-closed', 'fail-open'] as const;
export type RedisFailurePolicy = typeof VALID_REDIS_FAILURE_POLICIES[number];

/**
 * Parses and validates the REDIS_FAILURE_BEHAVIOR configuration setting.
 * Guarantees that only valid values ('fail-closed' | 'fail-open') are accepted,
 * and rejects unapproved fail-open configurations in production.
 */
export function parseAndValidateRedisFailurePolicy(
  rawPolicy?: string,
  nodeEnv = process.env.NODE_ENV
): { policy: RedisFailurePolicy; warning?: string; error?: string } {
  const isProduction = nodeEnv === 'production';
  const normalized = rawPolicy ? rawPolicy.trim().toLowerCase() : undefined;

  // Validate value against allowed policies
  if (normalized && !VALID_REDIS_FAILURE_POLICIES.includes(normalized as any)) {
    return {
      policy: 'fail-closed',
      error: `Invalid REDIS_FAILURE_BEHAVIOR '${rawPolicy}'. Allowed values: ${VALID_REDIS_FAILURE_POLICIES.join(', ')}. Defaulting to fail-closed.`
    };
  }

  if (isProduction) {
    if (normalized === 'fail-open') {
      if (process.env.ALLOW_UNSAFE_REDIS_FAIL_OPEN === 'true') {
        return {
          policy: 'fail-open',
          warning: '[Rate Limit SECURITY WARNING] Unsafe fail-open rate limiting permitted in production via ALLOW_UNSAFE_REDIS_FAIL_OPEN=true. Distributed rate limits are bypassed.'
        };
      }
      return {
        policy: 'fail-closed',
        error: '[Rate Limit SECURITY GUARD] REDIS_FAILURE_BEHAVIOR=fail-open rejected in production without ALLOW_UNSAFE_REDIS_FAIL_OPEN=true. Enforcing fail-closed.'
      };
    }
    return { policy: 'fail-closed' };
  }

  // Non-production (preview, test, dev)
  return { policy: normalized === 'fail-open' ? 'fail-open' : 'fail-closed' };
}

/**
 * Returns the effective rate-limit failure policy.
 * In production, defaults strictly to 'fail-closed' unless explicitly overridden by break-glass flag.
 */
export function getEffectiveRedisFailurePolicy(): RedisFailurePolicy {
  const result = parseAndValidateRedisFailurePolicy(process.env.REDIS_FAILURE_BEHAVIOR);
  if (result.error) {
    console.error(result.error);
  }
  if (result.warning) {
    console.warn(result.warning);
  }
  return result.policy;
}

export async function checkRateLimit(projectId: string, routeId: string, identifier: string) {
  // Phase 4: Atomic Token Bucket via Lua
  const key = `ratelimit:${routeId}:${identifier}`;
  
  // Fetch dynamic limits from the database policy
  let limit = 20;
  let refillRate = 20;
  try {
    const [policy] = await db.select().from(securityPolicies).where(eq(securityPolicies.routeId, routeId));
    if (policy && policy.rateLimitRpm) {
      limit = policy.rateLimitRpm;
      refillRate = policy.rateLimitRpm;
    }
  } catch (err) {
    console.error('[Rate Limit] DB Policy lookup failed, using defaults', err);
  }
  
  const evaluateLocalBucket = () => {
    pruneFallbackStore();
    const bucket = fallbackStore.get(key) || { tokens: limit, lastRefill: Date.now() };
    const now = Date.now();
    const timePassed = Math.max(0, now - bucket.lastRefill);
    const refill = Math.floor(timePassed * (refillRate / 60000));

    if (refill > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    let allowed = false;
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      allowed = true;
    }

    fallbackStore.set(key, bucket);
    return { allowed, limit, remaining: bucket.tokens };
  };

  // Handle Redis connection unavailable
  if (redis.status !== 'ready') {
    const policy = getEffectiveRedisFailurePolicy();

    if (policy === 'fail-closed') {
      console.error('[Rate Limit] Redis unavailable, enforcing fail-closed policy (request blocked)');
      return { allowed: false, limit, remaining: 0 };
    }

    // In fail-open mode (development / preview only or explicit override), use bounded local in-memory fallback
    // NOTE: Local in-memory fallback enforces rate limits ONLY within this single process, NOT across distributed replicas.
    return evaluateLocalBucket();
  }

  // Standalone single-instance mode (no external Redis configured): enforce rate limits via bounded in-memory token bucket
  if (!isRealRedisActive) {
    return evaluateLocalBucket();
  }

  const script = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refillRate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    
    local bucket = redis.call("HMGET", key, "tokens", "last_refill")
    local tokens = tonumber(bucket[1])
    local last_refill = tonumber(bucket[2])
    
    if not tokens then
      tokens = capacity
      last_refill = now
    end
    
    local time_passed = math.max(0, now - last_refill)
    local refill = math.floor(time_passed * (refillRate / 60000))
    
    if refill > 0 then
      tokens = math.min(capacity, tokens + refill)
      last_refill = now
    end
    
    local allowed = 0
    if tokens > 0 then
      tokens = tokens - 1
      allowed = 1
    end
    
    redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
    redis.call("PEXPIRE", key, 60000)
    
    return { allowed, tokens }
  `;
  
  try {
    const result = await redis.eval(script, 1, key, limit, refillRate, Date.now()) as [number, number];
    
    return {
      allowed: result[0] === 1,
      limit,
      remaining: result[1]
    };
  } catch (error) {
    const policy = getEffectiveRedisFailurePolicy();
    if (policy === 'fail-open') {
      console.warn('[Rate Limit] Redis evaluation error, using bounded local token bucket per fail-open policy');
      return evaluateLocalBucket();
    }
    console.error('[Rate Limit] Redis evaluation error, failing closed per policy');
    return {
      allowed: false,
      limit,
      remaining: 0
    };
  }
}
