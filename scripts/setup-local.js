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

console.log('------------------------------------------------------------');
console.log(' FortiX Free Local Setup - Initializing Local Environment   ');
console.log('------------------------------------------------------------');

if (fs.existsSync(envPath)) {
  console.log('✓ A .env file already exists in this project directory.');
  console.log('  If you wish to re-generate it, delete or backup your existing .env first.');
  process.exit(0);
}

// Generate cryptographically random local secrets on the fly
const localJwtSecret = crypto.randomBytes(32).toString('hex');
const localEncryptionKey = crypto.randomBytes(32).toString('hex');
const localDbPassword = crypto.randomBytes(16).toString('hex');

const envContent = `# ==============================================================================
# FortiX Local Environment Configuration (Auto-Generated)
# Generated locally on device: ${new Date().toISOString()}
# 100% Free - Stored exclusively on your local device.
# ==============================================================================

# Application Runtime
NODE_ENV=development
PORT=3000

# Standalone Local Mode:
# When STRICT_PERSISTENT_DB=false, FortiX runs completely in-memory (pg-mem & mock Redis)
# No external database or Redis server installation required!
STRICT_PERSISTENT_DB=false
START_INTERNAL_WORKER=true
START_DEMO_API=true

# Local Cryptographic Secrets (Generated randomly on your computer for FREE)
JWT_SECRET=${localJwtSecret}
ENCRYPTION_KEY=${localEncryptionKey}

# Local Database Credentials (Used if running local PostgreSQL / Docker)
POSTGRES_USER=fortix
POSTGRES_PASSWORD=${localDbPassword}
POSTGRES_DB=fortix_db
DATABASE_URL=postgres://fortix:${localDbPassword}@localhost:5432/fortix_db

# Local Redis Connection
REDIS_URL=redis://localhost:6379
`;

fs.writeFileSync(envPath, envContent, 'utf-8');

console.log('✓ Successfully created .env with locally generated credentials:');
console.log(`  - JWT_SECRET: Generated 256-bit local secret`);
console.log(`  - ENCRYPTION_KEY: Generated 256-bit local AES key`);
console.log(`  - POSTGRES_PASSWORD: Generated local database password`);
console.log('');
console.log('How to run FortiX for FREE on your device:');
console.log('  1. In-Memory Standalone Mode (Zero installs needed):');
console.log('     Run: npm run dev');
console.log('  2. Free Local Docker Mode (If Docker is installed):');
console.log('     Run: docker compose up -d');
console.log('------------------------------------------------------------');
