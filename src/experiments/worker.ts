import { db } from '../db/index.js';
import { experiments, apiRoutes, securityPolicies, apiKeys } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { verifyPolicy } from '../verification/engine.js';
import { invalidateApiKeyCache, invalidateExpCache } from '../gateway/index.js';
import { resolveGatewayPort } from '../lib/port.js';
import { logger } from '../lib/logger.js';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

dotenv.config();

async function generateTempApiKey(projectId: string) {
  const keyId = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const secretHash = await bcrypt.hash(secret, 10);
  const keyPrefix = `fx_test_${keyId}`;

  await db.insert(apiKeys).values({
    id: keyId,
    projectId,
    keyPrefix,
    name: 'Experiment Worker Key',
    secretHash,
    expiresAt: new Date(Date.now() + 1000 * 60 * 15),
    createdAt: new Date(),
  });

  return { id: keyId, raw: `${keyPrefix}_${secret}` };
}

async function runProxyTrafficBurst(targetUrl: string, expId: string, durationMs: number, projectId: string) {
  let tempKey: { id: string; raw: string } | undefined;
  const headers: Record<string, string> = { 'x-experiment-id': expId };

  try {
    tempKey = await generateTempApiKey(projectId);
    headers['x-api-key'] = tempKey.raw;

    const endTime = Date.now() + durationMs;
    let calls = 0;

    while (Date.now() < endTime && calls < 200) {
      calls++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        await fetch(targetUrl, { headers, signal: controller.signal }).finally(() => clearTimeout(timer));
      } catch (e) {
        logger.debug({ err: e, expId }, '[ExperimentWorker] Probe request error');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    if (tempKey) {
      try {
        await db.delete(apiKeys).where(eq(apiKeys.id, tempKey.id));
      } finally {
        invalidateApiKeyCache(tempKey.id, projectId);
      }
    }
  }
}

export async function runExperimentLogic(experimentId: string) {
  const [exp] = await db.select().from(experiments).where(eq(experiments.id, experimentId)).limit(1);
  if (!exp) {
    throw new Error(`Experiment '${experimentId}' not found`);
  }

  await db.update(experiments).set({ status: 'RUNNING', startedAt: new Date() }).where(eq(experiments.id, experimentId));
  invalidateExpCache(exp.routeId);

  const [route] = await db.select().from(apiRoutes).where(eq(apiRoutes.id, exp.routeId)).limit(1);

  if (!route) {
    await db.update(experiments).set({ status: 'FAILED', completedAt: new Date() }).where(eq(experiments.id, experimentId));
    invalidateExpCache(exp.routeId);
    throw new Error(`Route '${exp.routeId}' for experiment '${experimentId}' not found`);
  }

  const gatewayPort = resolveGatewayPort();
  const target = `http://127.0.0.1:${gatewayPort}/proxy/${route.id}`;
  const startTime = new Date();

  try {
    if (
      exp.type === 'latency' ||
      exp.type === 'error_5xx' ||
      exp.type === 'timeout' ||
      exp.type === 'traffic_burst'
    ) {
      const expDuration = Math.min((exp.config as any)?.durationMs || 5000, 10000);
      await runProxyTrafficBurst(target, exp.id, expDuration, route.projectId);
    }

    await db.update(experiments).set({ status: 'ANALYZING' }).where(eq(experiments.id, experimentId));
    invalidateExpCache(exp.routeId);
    const endTime = new Date();

    const [policy] = await db.select().from(securityPolicies).where(eq(securityPolicies.routeId, exp.routeId)).limit(1);
    if (policy) {
      await verifyPolicy(exp.id, policy.id, startTime, endTime);
    }

    await db.update(experiments).set({ status: 'COMPLETED', completedAt: new Date() }).where(eq(experiments.id, experimentId));
    invalidateExpCache(exp.routeId);
  } catch (error) {
    logger.error({ err: error, experimentId }, '[ExperimentWorker] Experiment execution failed');
    await db.update(experiments).set({ status: 'FAILED', completedAt: new Date() }).where(eq(experiments.id, experimentId));
    invalidateExpCache(exp.routeId);
    throw error;
  }
}
