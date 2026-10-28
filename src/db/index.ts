import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePgJs } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import * as dotenv from 'dotenv';
import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { normalizeDatabaseUrl, resolvePostgresSslOption, isLocalDatabaseHost } from './url.js';

dotenv.config({ override: true });

const isTest =
  (process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)) &&
  process.env.TEST_AGAINST_PERSISTENT !== 'true';
const isProduction = !isTest && process.env.NODE_ENV === 'production';
const strictPersistentDb = !isTest && process.env.STRICT_PERSISTENT_DB === 'true';

let storageMode: 'persistent' | 'in-memory' = 'in-memory';

function createMemDb() {
  console.log('[Database] Initializing high-performance resilient in-memory PostgreSQL engine (pg-mem)...');
  const mem = newDb();
  mem.registerExtension('uuid-ossp', (s) => {
    s.registerFunction({
      name: 'uuid_generate_v4',
      returns: 'uuid' as any,
      implementation: () => require('crypto').randomUUID()
    });
  });

  const files = ['0000_dizzy_moon_knight.sql', '0001_spicy_jackpot.sql', '0002_webhook_deliveries.sql', '0003_workflow_runs.sql'];
  for (const file of files) {
    const filePath = path.join(process.cwd(), 'drizzle', file);
    if (fs.existsSync(filePath)) {
      const sqlContent = fs.readFileSync(filePath, 'utf8');
      for (const stmt of sqlContent.split('--> statement-breakpoint')) {
        const clean = stmt.trim();
        if (clean) {
          try { mem.public.none(clean); } catch (e) {}
        }
      }
    }
  }

  const pg = mem.adapters.createPg();
  const OrigPool = pg.Pool;
  class PatchedPool extends OrigPool {
    query(queryTextOrConfig: any, values?: any, callback?: any) {
      if (queryTextOrConfig && typeof queryTextOrConfig === 'object') {
        delete queryTextOrConfig.types;
        const isArrayMode = queryTextOrConfig.rowMode === 'array';
        if (isArrayMode) delete queryTextOrConfig.rowMode;
        const origPromise = super.query(queryTextOrConfig, values, callback);
        if (isArrayMode) {
          return origPromise.then((res: any) => {
            if (res && res.rows && res.rows.length > 0) {
              const keys = Object.keys(res.rows[0]);
              const arrayRows = res.rows.map((row: any) => keys.map((k) => row[k]));
              return { ...res, rows: arrayRows, fields: keys.map(k => ({ name: k })) };
            }
            return res;
          });
        }
        return origPromise;
      }
      return super.query(queryTextOrConfig, values, callback);
    }
  }

  const pool = new PatchedPool();
  const memDb = drizzleNodePg(pool, { schema });

  // STRICT SAFEGUARD: Only seed preview accounts in non-production environments
  if (!isProduction && process.env.SEED_PREVIEW_DATA !== 'false') {
    (async () => {
      try {
        const bcrypt = await import('bcryptjs');
        const hash1 = await bcrypt.hash('AdminPassword123!', 10);
        const hash2 = await bcrypt.hash('password123', 10);

        await memDb.insert(schema.users).values([
          {
            id: '00000000-0000-0000-0000-000000000001',
            email: 'admin@fortix.io',
            passwordHash: hash1,
            role: 'ADMIN'
          },
          {
            id: '00000000-0000-0000-0000-000000000002',
            email: 'admin@fortix.test',
            passwordHash: hash2,
            role: 'ADMIN'
          }
        ]).onConflictDoNothing();

        await memDb.insert(schema.organizations).values([
          {
            id: '00000000-0000-0000-0000-000000000001',
            name: 'Default Org',
            ownerId: '00000000-0000-0000-0000-000000000001'
          },
          {
            id: '00000000-0000-0000-0000-000000000002',
            name: 'Default Org',
            ownerId: '00000000-0000-0000-0000-000000000002'
          }
        ]).onConflictDoNothing();

        await memDb.insert(schema.projects).values([
          {
            id: '00000000-0000-0000-0000-000000000001',
            orgId: '00000000-0000-0000-0000-000000000001',
            name: 'Production Gateway',
            environment: 'production'
          },
          {
            id: '00000000-0000-0000-0000-000000000002',
            orgId: '00000000-0000-0000-0000-000000000002',
            name: 'Production Gateway',
            environment: 'production'
          }
        ]).onConflictDoNothing();

        await memDb.insert(schema.apiRoutes).values([
          {
            id: '00000000-0000-0000-0000-000000000001',
            projectId: '00000000-0000-0000-0000-000000000001',
            pathPattern: '/api/v1/data',
            targetUrl: 'http://fortix-demo-api:3001/api/v1/data'
          },
          {
            id: '00000000-0000-0000-0000-000000000002',
            projectId: '00000000-0000-0000-0000-000000000002',
            pathPattern: '/api/v1/data',
            targetUrl: 'http://fortix-demo-api:3001/api/v1/data'
          }
        ]).onConflictDoNothing();

        console.log('[Database] Preview database seeded with developer accounts (non-production only).');
      } catch (e) {
        console.warn('[Database] Seed warning:', e);
      }
    })();
  }

  return memDb;
}

function initializeDatabase() {
  const rawConnectionString = process.env.DATABASE_URL;
  const connectionString = normalizeDatabaseUrl(rawConnectionString);

  // Enforcement: Production or strict persistent mode MUST have a real persistent PostgreSQL database
  if (isProduction || strictPersistentDb) {
    if (
      !connectionString ||
      connectionString.includes('memory') ||
      connectionString.includes('your_strong_database_password_here') ||
      connectionString.trim() === ''
    ) {
      throw new Error(
        '[FATAL SECURITY SAFEGUARD] Production startup rejected: Persistent PostgreSQL database (DATABASE_URL) is required in production (STRICT_PERSISTENT_DB or NODE_ENV=production). In-memory fallback (pg-mem) is strictly prohibited in production.'
      );
    }

    try {
      console.log('[Database] Connecting to persistent PostgreSQL database in production/strict mode...');
      const client = postgres(connectionString, {
        prepare: false,
        ssl: resolvePostgresSslOption(connectionString) as any,
        connect_timeout: 15,
        idle_timeout: 20,
        max_lifetime: 60 * 30,
        max: 10,
      });
      storageMode = 'persistent';
      return drizzlePgJs(client, { schema });
    } catch (err: any) {
      throw new Error(`[FATAL] Failed to initialize persistent PostgreSQL client in production: ${err?.message || err}`);
    }
  }

  const isPlaceholder = connectionString.includes('your_strong_database_password_here');
  const isRemoteOrExplicitLocal =
    !isLocalDatabaseHost(connectionString) || process.env.USE_LOCAL_POSTGRES === 'true';

  if (
    !isTest &&
    connectionString &&
    !isPlaceholder &&
    !connectionString.includes('memory') &&
    !connectionString.includes('render.com') &&
    isRemoteOrExplicitLocal &&
    process.env.FORCE_IN_MEMORY !== 'true'
  ) {
    try {
      console.log('[Database] Connecting to configured persistent PostgreSQL database...');
      const client = postgres(connectionString, {
        prepare: false,
        ssl: resolvePostgresSslOption(connectionString) as any,
        connect_timeout: 15,
        idle_timeout: 20,
        max_lifetime: 60 * 30,
        max: 10,
      });
      storageMode = 'persistent';
      return drizzlePgJs(client, { schema });
    } catch {
      console.warn('[Database] Could not initialize configured DATABASE_URL in non-production mode. Falling back to pg-mem.');
    }
  }

  storageMode = 'in-memory';
  return createMemDb();
}

export const db = initializeDatabase();

export function getStorageMode(): 'persistent' | 'in-memory' {
  return storageMode;
}

export function isPersistentStorage(): boolean {
  return storageMode === 'persistent';
}
