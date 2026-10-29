import { Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { apiKeys, projects } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { apiKeyCache } from '../gateway/index.js';

export interface FortixApiKeyPayload {
  id: string;
  projectId: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      apiKey?: FortixApiKeyPayload;
    }
  }
}

/**
 * Express middleware to authenticate FortiX-issued API keys with scope enforcement,
 * project isolation, expiration checks, and caching.
 */
export function authenticateFortixApiKey(requiredScope?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let rawKey = req.headers['x-api-key'] as string;

    if (!rawKey && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer fx_') || authHeader.startsWith('Bearer FX_')) {
        rawKey = authHeader.substring(7).trim();
      }
    }

    if (!rawKey) {
      return res.status(401).json({ error: 'Missing FortiX API Key in x-api-key or Authorization Bearer header' });
    }

    const parts = rawKey.split('_');
    if (parts.length !== 4 || parts[0].toLowerCase() !== 'fx') {
      return res.status(401).json({ error: 'Malformed FortiX API Key format. Expected fx_<env>_<keyId>_<secret>' });
    }

    const keyId = parts[2];
    const secret = parts[3];

    try {
      let keyRecord: any = null;

      // Check cache first (must validate both revocation and expiration)
      const cached = apiKeyCache.get(rawKey);
      if (cached && Date.now() - cached.cachedAt < 30000) {
        const notExpired = !cached.key?.expiresAt || new Date(cached.key.expiresAt) > new Date();
        if (cached.key && !cached.key.revokedAt && notExpired) {
          keyRecord = cached.key;
        } else {
          apiKeyCache.delete(rawKey);
        }
      }

      if (!keyRecord) {
        const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);

        if (!k) {
          return res.status(401).json({ error: 'Invalid API Key' });
        }

        if (k.revokedAt) {
          return res.status(401).json({ error: 'API Key has been revoked' });
        }

        if (k.expiresAt && new Date(k.expiresAt) <= new Date()) {
          return res.status(401).json({ error: 'API Key has expired' });
        }

        const validSecret = await bcrypt.compare(secret, k.secretHash);
        if (!validSecret) {
          return res.status(401).json({ error: 'Invalid API Key secret' });
        }

        const { secretHash: _omitSecretHash, ...safeKeyRecord } = k;
        keyRecord = safeKeyRecord;
        apiKeyCache.set(rawKey, { key: safeKeyRecord, cachedAt: Date.now() });
      }

      // Check project isolation across all supplied projectId locations (header, params, query, body)
      const candidateProjectIds = [
        req.headers['x-fortix-project-id'],
        req.params?.projectId,
        req.query?.projectId,
        req.body?.projectId,
      ].filter((val): val is string => typeof val === 'string' && val.trim().length > 0 && val !== 'undefined' && val !== 'null');

      for (const expectedProjectId of candidateProjectIds) {
        if (keyRecord.projectId !== expectedProjectId.trim()) {
          return res.status(403).json({ error: 'Cross-project access forbidden: Key does not belong to specified project' });
        }
      }

      // Check required scope
      const scopes: string[] = Array.isArray(keyRecord.scopes) ? keyRecord.scopes : [];
      if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('admin') && !scopes.includes('*')) {
        return res.status(403).json({
          error: `Insufficient scope: Key lacks '${requiredScope}' permission`,
          assignedScopes: scopes,
        });
      }

      req.apiKey = {
        id: keyRecord.id,
        projectId: keyRecord.projectId,
        keyPrefix: keyRecord.keyPrefix,
        name: keyRecord.name,
        scopes,
      };

      next();
    } catch (err) {
      console.error('[FortiX ApiKeyAuth] Authentication error:', err);
      res.status(500).json({ error: 'Internal API Key verification error' });
    }
  };
}
