import { runMigrations } from './migrate.js';
import { logger } from '../lib/logger.js';

export async function initDatabase(): Promise<void> {
  try {
    logger.info('[Database] Initializing automated database migrations...');
    await runMigrations();
    logger.info('[Database] Automated database migrations applied successfully.');
  } catch (error) {
    const isStrict = process.env.STRICT_PERSISTENT_DB === 'true';
    if (isStrict) {
      logger.error({ err: error }, '[FATAL] Database migration failed in strict persistent mode. Halting startup.');
      throw new Error(`[FATAL] Database migration failed in strict persistent mode: ${error instanceof Error ? error.message : error}`);
    }
    logger.warn({ err: error }, '[Database] Database migration not completed on startup, proceeding with fallback mode.');
  }
}
