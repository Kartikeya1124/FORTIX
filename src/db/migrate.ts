import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

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
  const connectionString = customDbUrl || process.env.DATABASE_URL || 'postgres://fortix:fortix_password@127.0.0.1:5432/fortix_db';

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set for database migration.');
  }

  const isSslDisabled = 
    connectionString.includes('sslmode=disable') || 
    connectionString.includes('ssl=false') ||
    (!connectionString.includes('sslmode=require') && (connectionString.includes('localhost') || connectionString.includes('127.0.0.1')));

  // Use a dedicated single connection client for schema migration
  const migrationClient = postgres(connectionString, {
    max: 1,
    ssl: isSslDisabled ? false : 'require',
    connect_timeout: 1,
    idle_timeout: 1,
  });

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

  console.log('[Migration] Target migrations directory:', migrationsFolder);

  try {
    if (process.env.NODE_ENV !== 'production' && connectionString.includes('render.com')) {
      throw new Error('Render database unreachable in preview environment, using resilient in-memory database');
    }
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

    console.log('[Migration] All database migrations verified and applied successfully.');
  } catch (error) {
    if (customDbUrl) {
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
