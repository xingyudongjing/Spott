import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import { createPostgresDatabaseOwnershipCoordinator } from './e2e/database-harness.js';
import {
  assertAppliedMigrationPrefixMatchesManifest,
  assertAppliedMigrationsMatchManifest,
  loadMigrationManifest,
  type AppliedMigration,
} from './e2e/migration-manifest.js';
import { applyManifestMigration } from './e2e/migration-transaction.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const environmentPath = join(repositoryRoot, '.env');
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required');

const migrationsDirectory = join(repositoryRoot, 'database', 'migrations');
const migrationManifest = await loadMigrationManifest({
  manifestPath: join(repositoryRoot, 'database', 'migration-manifest.json'),
  migrationsDirectory,
});
await verifyRequestedDatabaseOwnership(databaseURL);
const client = new Client({ connectionString: databaseURL });

await client.connect();
let locked = false;
try {
  await client.query('SELECT pg_advisory_lock($1)', [8_672_026_071_500]);
  locked = true;
  const tableExists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  let appliedRows: AppliedMigration[] = [];
  if (tableExists.rows[0]?.exists) {
    const result = await client.query<AppliedMigration>(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
    );
    appliedRows = result.rows;
  }
  assertAppliedMigrationPrefixMatchesManifest(appliedRows, migrationManifest);

  for (const migration of migrationManifest.slice(appliedRows.length)) {
    const sql = await readFile(join(migrationsDirectory, migration.filename), 'utf8');
    console.info(`apply ${migration.filename}`);
    await applyManifestMigration(client, migration, sql);
  }

  const completeRows = await client.query<AppliedMigration>(
    'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
  );
  assertAppliedMigrationsMatchManifest(completeRows.rows, migrationManifest);
  console.info(`verified ${migrationManifest.length} immutable migration checksums`);
} finally {
  try {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [8_672_026_071_500]);
  } finally {
    await client.end();
  }
}

async function verifyRequestedDatabaseOwnership(targetDatabaseURL: string): Promise<void> {
  const required = process.env.SPOTT_DATABASE_OWNERSHIP_REQUIRED;
  const adminURL = process.env.SPOTT_DATABASE_ADMIN_URL;
  const runId = process.env.SPOTT_DATABASE_RUN_ID;
  const runToken = process.env.SPOTT_DATABASE_RUN_TOKEN;
  if (required === undefined) {
    if (adminURL || runId || runToken) {
      throw new Error('DATABASE_OWNERSHIP_CONFIGURATION_AMBIGUOUS');
    }
    return;
  }
  if (required !== '1' || !adminURL || !runId || !runToken) {
    throw new Error('DATABASE_OWNERSHIP_CONFIGURATION_INVALID');
  }
  const coordinator = createPostgresDatabaseOwnershipCoordinator({
    adminURL,
    targetURL: targetDatabaseURL,
    runId,
    runToken,
  });
  await coordinator.verifyReady();
}
