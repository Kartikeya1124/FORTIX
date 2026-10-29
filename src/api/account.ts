import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, organizations, projects, apiKeys } from '../db/schema.js';
import { AuthRequest } from '../middleware/auth.js';
import {
  recordPasswordRotation,
  computePasswordVersion,
  getJwtSecret,
  extractRequestToken,
  revokeJwtToken,
} from '../lib/jwt-security.js';
import {
  issueSessionCookie,
  issueCsrfCookie,
  clearSessionCookies,
} from '../lib/cors-csrf.js';
import { disconnectSocketsForUser } from '../socket.js';
import { invalidateApiKeyCache } from '../gateway/index.js';
import { publishKeyRevocation } from '../lib/key-invalidation.js';

const router = express.Router();

router.get('/me', async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  try {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const hasWorkspaceEntitlements = user.role === 'ADMIN' || user.role === 'DEVELOPER';
    const entitlements = {
      advancedExperiments: hasWorkspaceEntitlements,
      policyVerification: hasWorkspaceEntitlements,
      advancedAnalytics: hasWorkspaceEntitlements,
      realtimeTelemetry: hasWorkspaceEntitlements,
      topology: hasWorkspaceEntitlements,
      advancedSecurity: hasWorkspaceEntitlements,
      reportExport: hasWorkspaceEntitlements,
      platformAdmin: user.role === 'ADMIN',
    };

    res.json({ ...user, entitlements });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

router.post('/password', async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  try {
    const { currentPassword, newPassword } = passwordSchema.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) return res.status(400).json({ error: 'Invalid current password' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, userId));

    await recordPasswordRotation(userId, newHash);
    disconnectSocketsForUser(userId);

    const freshToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        pwdVer: computePasswordVersion(newHash),
        jti: uuidv4(),
      },
      getJwtSecret(),
      { expiresIn: '1d', algorithm: 'HS256' }
    );

    issueSessionCookie(req, res, freshToken);
    const csrfToken = issueCsrfCookie(req, res);

    res.json({ success: true, token: freshToken, csrfToken });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal('DELETE'),
});

router.delete('/', async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  try {
    const { password } = deleteAccountSchema.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid password confirmation' });
    }

    // 1. Immediately revoke active session token & close authenticated sockets
    const activeToken = extractRequestToken(req);
    if (activeToken) {
      await revokeJwtToken(activeToken);
    }
    await recordPasswordRotation(userId, `deleted:${Date.now()}`);
    disconnectSocketsForUser(userId);

    // 2. Evict and broadcast revocation for all gateway API keys across owned projects
    const ownedOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.ownerId, userId));

    if (ownedOrgs.length > 0) {
      const orgIds = ownedOrgs.map((o) => o.id);
      const ownedProjects = await db
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.orgId, orgIds));

      if (ownedProjects.length > 0) {
        const projIds = ownedProjects.map((p) => p.id);
        const ownedKeys = await db
          .select({ id: apiKeys.id, projectId: apiKeys.projectId })
          .from(apiKeys)
          .where(inArray(apiKeys.projectId, projIds));

        for (const k of ownedKeys) {
          invalidateApiKeyCache(k.id);
          await publishKeyRevocation({
            event: 'api_key.revoked',
            keyId: k.id,
            projectId: k.projectId,
            timestamp: new Date().toISOString(),
            reason: 'account_deleted',
          });
        }
      }
    }

    // 3. Delete user row (FK ON DELETE CASCADE removes owned organizations, projects, routes, keys, policies, webhooks, tokens)
    await db.delete(users).where(eq(users.id, userId));
    clearSessionCookies(req, res);

    res.status(200).json({
      deleted: true,
      message: 'Account, active sessions, API keys, and owned workspaces have been permanently deleted.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Password and exact confirmation string "DELETE" are required to delete your account.',
        details: error.issues,
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const accountRouter = router;
