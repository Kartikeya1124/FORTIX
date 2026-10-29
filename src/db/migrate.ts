import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { normalizeDatabaseUrl, resolvePostgresSslOption, isLocalDatabaseHost } from './url.js';

dotenv.config({ override: true });

function getModuleDirname(): string {
  if (typeof __dirname !== 'undefined' && __dirname) {
    return __dirname;
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta && import.meta.url) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // fallback to process.cwd()
  }
  return process.cwd();
}

export async function runMigrations(customDbUrl?: string, customMigrationsFolder?: string): Promise<void> {
  const rawConn = customDbUrl || process.env.DATABASE_URL || '';
  const connectionString = normalizeDatabaseUrl(rawConn);
  const strictPersistent = Boolean(customDbUrl) || process.env.STRICT_PERSISTENT_DB === 'true';

  if (strictPersistent && !connectionString) {
    throw new Error('DATABASE_URL is required when running strict persistent database migrations.');
  }

  // Determine migrations folder
  const currentDir = getModuleDirname();
  let migrationsFolder = customMigrationsFolder;
  if (!migrationsFolder) {
    const candidatePaths = [
      path.resolve(process.cwd(), 'drizzle'),
      path.resolve(currentDir, '../../drizzle'),
      path.resolve(currentDir, '../drizzle'),
      path.resolve(currentDir, 'drizzle'),
    ];
    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) {
        migrationsFolder = candidate;
        break;
      }
    }
    if (!migrationsFolder) {
      migrationsFolder = path.resolve(process.cwd(), 'drizzle');
    }
  }

  const isIsolatedUnitTest =
    !customDbUrl &&
    (process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)) &&
    process.env.TEST_AGAINST_PERSISTENT !== 'true';

  if (!customDbUrl) {
    const { db, getStorageMode } = await import('./index.js');
    if (isIsolatedUnitTest || getStorageMode() === 'in-memory' || !connectionString) {
      if (strictPersistent) {
        throw new Error('Refusing in-memory migration tracking while STRICT_PERSISTENT_DB=true.');
      }
      await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id int,
          hash text,
          created_at bigint
        )
      `);
      const countRes = await db.execute(sql`SELECT COUNT(*)::int as count FROM drizzle.__drizzle_migrations`);
      const count = (Array.isArray(countRes) ? countRes[0]?.count : (countRes as any)?.rows?.[0]?.count) ?? 0;
      if (count === 0 && migrationsFolder) {
        const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
        if (fs.existsSync(journalPath)) {
          const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
          let seq = 1;
          for (const entry of journal.entries) {
            const sqlFilePath = path.join(migrationsFolder, `${entry.tag}.sql`);
            if (fs.existsSync(sqlFilePath)) {
              const fileContent = fs.readFileSync(sqlFilePath, 'utf8');
              const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
              await db.execute(sql`
                INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
                VALUES (${seq++}, ${hash}, ${entry.when})
              `);
            }
          }
        }
      }
      return;
    }
  }

  const isLocal = isLocalDatabaseHost(connectionString);

  // Use a dedicated single connection client for schema migration
  const migrationClient = postgres(connectionString, {
    max: 1,
    prepare: false,
    ssl: resolvePostgresSslOption(connectionString) as any,
    connect_timeout: isLocal ? 2 : 15,
    idle_timeout: 5,
  });

  console.log('[Migration] Target migrations directory:', migrationsFolder);

  try {
    // 1. Verify Postgres connectivity
    await migrationClient`SELECT 1 as connected`;

    // 2. Ensure migration tracking schema and table exist
    await migrationClient`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await migrationClient`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id int,
        hash text,
        created_at bigint
      )
    `;

    // 3. Check if this is an existing pre-migrated database without drizzle tracking records
    const migrationCountRes = await migrationClient`
      SELECT COUNT(*)::int as count FROM drizzle.__drizzle_migrations
    `;
    const migrationCount = migrationCountRes[0]?.count ?? 0;

    if (migrationCount === 0) {
      // Check if core business tables already exist in public schema
      const existingTables = await migrationClient`
        SELECT table_name as tablename FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
      `;

      if (existingTables.length > 0) {
        console.log('[Migration] Detected existing pre-populated schema. Baselining existing migrations...');
        const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
        if (fs.existsSync(journalPath)) {
          const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
          for (const entry of journal.entries) {
            const sqlFilePath = path.join(migrationsFolder, `${entry.tag}.sql`);
            if (fs.existsSync(sqlFilePath)) {
              const fileContent = fs.readFileSync(sqlFilePath, 'utf8');
              const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
              await migrationClient`
                INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
                VALUES (${hash}, ${entry.when})
              `;
              console.log(`[Migration] Baselined migration: ${entry.tag}`);
            }
          }
        }
      }
    }

    // 4. Run Drizzle's authoritative migration pipeline
    const migrationDb = drizzle(migrationClient);
    await migrate(migrationDb, { migrationsFolder });

    // 4b. Apply PostgreSQL defense-in-depth Row-Level Security policies when enabled
    if (process.env.ENABLE_POSTGRES_RLS !== 'false') {
      const rlsPath = path.join(migrationsFolder, 'postgres_rls_policies.sql');
      if (fs.existsSync(rlsPath)) {
        const rlsSql = fs.readFileSync(rlsPath, 'utf8');
        await migrationClient.unsafe(rlsSql);
      }
    }

    // 5. Bootstrap default developer accounts on fresh empty database (non-production or explicit opt-in only)
    const allowSeed =
      !customDbUrl &&
      !Boolean(process.env.VITEST) &&
      ((process.env.NODE_ENV !== 'production' && process.env.SEED_PREVIEW_DATA !== 'false') ||
        process.env.SEED_DEFAULT_ADMIN === 'true');

    if (allowSeed) {
      const userCountRes = await migrationClient`SELECT COUNT(*)::int as count FROM users`;
      const userCount = userCountRes[0]?.count ?? 0;
      if (userCount === 0) {
        const bcrypt = await import('bcryptjs');
        const hash1 = await bcrypt.hash('AdminPassword123!', 10);
        const hash2 = await bcrypt.hash('password123', 10);

        await migrationClient`
          INSERT INTO users (id, email, password_hash, role)
          VALUES
            ('00000000-0000-0000-0000-000000000001', 'admin@fortix.io', ${hash1}, 'ADMIN'),
            ('00000000-0000-0000-0000-000000000002', 'admin@fortix.test', ${hash2}, 'ADMIN')
          ON CONFLICT DO NOTHING
        `;
      }

      const seedUserIds = [
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
      ];
      for (const uid of seedUserIds) {
        const existingUser = await migrationClient`SELECT id FROM users WHERE id = ${uid} LIMIT 1`;
        if (existingUser.length === 0) continue;

        let orgRows = await migrationClient`SELECT id FROM organizations WHERE owner_id = ${uid} LIMIT 1`;
        if (orgRows.length === 0) {
          await migrationClient`
            INSERT INTO organizations (id, name, owner_id)
            VALUES (${uid}, 'Default Org', ${uid})
            ON CONFLICT DO NOTHING
          `;
          orgRows = await migrationClient`SELECT id FROM organizations WHERE owner_id = ${uid} LIMIT 1`;
        }
        const orgId = orgRows[0]?.id;
        if (!orgId) continue;

        const projCountRes = await migrationClient`
          SELECT COUNT(*)::int as count FROM projects WHERE org_id = ${orgId}
        `;
        if ((projCountRes[0]?.count ?? 0) === 0) {
          await migrationClient`
            INSERT INTO projects (id, org_id, name, environment)
            VALUES (${uid}, ${orgId}, 'Production Gateway', 'production')
            ON CONFLICT DO NOTHING
          `;
          await migrationClient`
            INSERT INTO api_routes (id, project_id, path_pattern, target_url)
            VALUES (${uid}, ${uid}, '/api/v1/data', 'http://fortix-demo-api:3001/api/v1/data')
            ON CONFLICT DO NOTHING
          `;
        }
        await migrationClient`
          UPDATE api_routes
          SET target_url = 'http://fortix-demo-api:3001/api/v1/data'
          WHERE id = ${uid} AND target_url = 'http://localhost:3001/api/v1/data'
        `;
      }
    }

    console.log('[Migration] All database migrations verified and applied successfully.');
  } catch (error) {
    const isStrict =
      strictPersistent ||
      process.env.NODE_ENV === 'production';
    if (isStrict) {
      console.error('[Migration] Migration execution failed:', error instanceof Error ? error.message : error);
      throw error;
    }
    console.warn('[Migration] Remote migration connection failed, populating in-memory fallback database migrations...');
    try {
      const { db } = await import('./index.js');
      await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id int,
          hash text,
          created_at bigint
        )
      `);
      const countRes = await db.execute(sql`SELECT COUNT(*)::int as count FROM drizzle.__drizzle_migrations`);
      const count = (Array.isArray(countRes) ? countRes[0]?.count : (countRes as any)?.rows?.[0]?.count) ?? 0;
      if (count === 0 && migrationsFolder) {
        const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
        if (fs.existsSync(journalPath)) {
          const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
          for (const entry of journal.entries) {
            const sqlFilePath = path.join(migrationsFolder, `${entry.tag}.sql`);
            if (fs.existsSync(sqlFilePath)) {
              const fileContent = fs.readFileSync(sqlFilePath, 'utf8');
              const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
              await db.execute(sql`
                INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
                VALUES (${hash}, ${entry.when})
              `);
            }
          }
        }
      }
    } catch (fallbackErr) {
      console.warn('[Migration] Fallback migration registration warning:', fallbackErr);
    }
  } finally {
    await migrationClient.end();
  }
}

// Standalone CLI execution
if (process.argv[1] && (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'))) {
  runMigrations()
    .then(() => {
      console.log('[Migration] CLI migration run completed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] CLI migration run failed:', err);
      process.exit(1);
    });
}
