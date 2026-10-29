import express from 'express';
import { requireProjectOwnership } from './projects.js';
import { db } from '../db/index.js';
import { webhooks, webhookDeliveries } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { enqueueWebhookEvent, inMemoryWebhookDeliveries, executeWebhookDelivery } from '../lib/webhooks.js';
import { isSafeTarget, isAllowedDemoApiUrl } from '../gateway/ssrf.js';

const router = express.Router();

const webhookSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().max(2048),
  secret: z.string().max(512).optional(),
  events: z.array(z.string().min(1)).min(1),
  isActive: z.boolean().default(true),
});

function sanitizeWebhookRow(wh: any) {
  const { secret, ...rest } = wh;
  return {
    ...rest,
    hasSecret: Boolean(secret),
  };
}

function isSafeWebhookUrl(rawUrl: string): boolean {
  if (!isSafeTarget(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    // Outbound webhooks are external notification sinks and must not target internal demo loopback
    if (isAllowedDemoApiUrl(parsed)) return false;
    return true;
  } catch {
    return false;
  }
}

router.get('/', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  try {
    const list = await db.select().from(webhooks).where(eq(webhooks.projectId, projectId));
    res.json(list.map(sanitizeWebhookRow));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

router.post('/', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  try {
    const data = webhookSchema.parse(req.body);
    if (!isSafeWebhookUrl(data.url)) {
      return res.status(400).json({ error: 'Invalid or restricted webhook target URL (SSRF protection)' });
    }
    const newWebhook = {
      id: uuidv4(),
      projectId,
      ...data,
    };
    await db.insert(webhooks).values(newWebhook);
    res.json(sanitizeWebhookRow(newWebhook));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// Fetch delivery attempt history for a specific webhook with tenant verification
router.get('/:id/deliveries', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  const webhookId = req.params.id as string;

  try {
    const [wh] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, projectId)));

    if (!wh) {
      return res.status(404).json({ error: 'Webhook not found in this project' });
    }

    try {
      const records = await db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.projectId, projectId)))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(100);

      if (records.length > 0) {
        return res.json(records);
      }
    } catch {
      // Fall through to in-memory store
    }

    const matchingMem = inMemoryWebhookDeliveries
      .filter((d) => d.webhookId === webhookId && d.projectId === projectId)
      .slice(0, 100);

    res.json(matchingMem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch webhook deliveries' });
  }
});

// Trigger a test ping event delivery
router.post('/:id/test', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  const webhookId = req.params.id as string;

  try {
    const [wh] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, projectId)));

    if (!wh) {
      return res.status(404).json({ error: 'Webhook not found in this project' });
    }

    const testDeliveryId = uuidv4();
    const result = await executeWebhookDelivery(
      {
        deliveryId: testDeliveryId,
        webhookId: wh.id,
        projectId: wh.projectId,
        url: wh.url,
        secret: wh.secret,
        eventType: 'webhook.ping',
        payload: {
          event: 'webhook.ping',
          timestamp: new Date().toISOString(),
          projectId,
          message: 'FortiX automated webhook test ping',
        },
        maxAttempts: 1,
      },
      1
    );

    res.json({ success: true, deliveryId: testDeliveryId, ...result });
  } catch (error: any) {
    res.status(502).json({ error: 'Test delivery failed', message: error?.message });
  }
});

// Trigger an event to be queued across all project webhooks
router.post('/events', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  const { eventType, data } = req.body;

  if (!eventType) {
    return res.status(400).json({ error: 'Missing eventType parameter' });
  }

  try {
    const jobIds = await enqueueWebhookEvent(projectId, eventType, data || {});
    res.json({ success: true, eventType, queuedJobsCount: jobIds.length, jobIds });
  } catch (error) {
    res.status(500).json({ error: 'Failed to enqueue webhook event' });
  }
});

router.delete('/:id', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  const id = req.params.id as string;
  try {
    await db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.projectId, projectId)));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

router.patch('/:id/toggle', requireProjectOwnership, async (req, res) => {
  const projectId = String(req.query.projectId || req.body?.projectId || '');
  const id = req.params.id as string;
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'isActive must be a boolean' });
  }
  try {
    await db.update(webhooks).set({ isActive }).where(and(eq(webhooks.id, id), eq(webhooks.projectId, projectId)));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

export const webhooksRouter = router;
