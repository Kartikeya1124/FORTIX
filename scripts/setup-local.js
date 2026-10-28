#!/usr/bin/env node

/**
 * FortiX Local Environment Auto-Setup Script
 *
 * Generates a ready-to-use, secure .env file locally on your machine.
 * 100% Free - No paid services, no third-party accounts, and no subscriptions required.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const envPath = path.resolve(process.cwd(), '.env');
const args = process.argv.slice(2);
const isStaging = args.includes('--staging') || args.includes('--docker');
const forceOverwrite = args.includes('--force');

console.log('------------------------------------------------------------');
console.log(' FortiX Free Local Setup - Initializing Local Environment   ');
console.log('------------------------------------------------------------');

if (fs.existsSync(envPath) && !forceOverwrite) {
  console.log('✓ A .env file already exists in this project directory.');
  console.log('  Run with --force to regenerate local secrets (backs up existing .env to .env.bak).');
  process.exit(0);
}

if (fs.existsSync(envPath) && forceOverwrite) {
  fs.copyFileSync(envPath, `${envPath}.bak`);
}

// Generate cryptographically random local secrets on the fly (100% free, offline)
const localJwtSecret = crypto.randomBytes(32).toString('hex');
const localEncryptionKey = crypto.randomBytes(32).toString('hex');
const localDbPassword = crypto.randomBytes(16).toString('hex');

const envContent = `# ==============================================================================
# FortiX Local Environment Configuration (Auto-Generated)
# Generated locally on device: ${new Date().toISOString()}
# 100% Free - Stored exclusively on your local device. NEVER commit .env to Git.
# ==============================================================================

# Application Runtime
NODE_ENV=${isStaging ? 'production' : 'development'}
PORT=3000

# Runtime & Process Flags (Plain boolean/mode configuration - no paid service needed)
STRICT_PERSISTENT_DB=${isStaging ? 'true' : 'false'}
START_INTERNAL_WORKER=${isStaging ? 'false' : 'true'}
START_DEMO_API=${isStaging ? 'false' : 'true'}

# Local Cryptographic Secrets (Generated randomly on your computer for FREE)
JWT_SECRET=${localJwtSecret}
ENCRYPTION_KEY=${localEncryptionKey}

# PostgreSQL Database Credentials
# - For local Docker (docker compose up -d): uses these locally generated values automatically.
# - For Supabase Free Tier: replace DATABASE_URL with your Session Pooler URL (port 5432)
#   and percent-encode special characters in passwords (e.g. '@' -> '%40').
POSTGRES_USER=fortix
POSTGRES_PASSWORD=${localDbPassword}
POSTGRES_DB=fortix_db
DATABASE_URL=postgres://fortix:${localDbPassword}@localhost:5432/fortix_db

# Redis Connection & Failure Policy
# - For local Docker: redis://localhost:6379
# - For Upstash Free Tier: rediss://default:<token>@<endpoint>.upstash.io:6379
REDIS_URL=redis://localhost:6379
REDIS_FAILURE_BEHAVIOR=fail-closed
`;

fs.writeFileSync(envPath, envContent, { encoding: 'utf-8', mode: 0o600 });

console.log(`✓ Successfully created .env (${isStaging ? 'Docker/Staging persistent mode' : 'Local standalone mode'}):`);
console.log('  - JWT_SECRET: Generated 256-bit cryptographic secret');
console.log('  - ENCRYPTION_KEY: Generated 256-bit AES key (64 hex chars)');
console.log('  - POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD: Generated local DB credentials');
console.log('  - STRICT_PERSISTENT_DB / START_INTERNAL_WORKER / START_DEMO_API / REDIS_FAILURE_BEHAVIOR: Configured');
console.log('');
console.log('Next steps:');
console.log('  1. Zero-Install Standalone Mode: npm run dev');
console.log('  2. Local Docker Staging Mode:    npm run setup:local -- --staging --force && docker compose up --build -d');
console.log('------------------------------------------------------------');
