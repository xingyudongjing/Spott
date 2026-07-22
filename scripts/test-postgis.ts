import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

import {
  assertAppliedMigrationPrefixMatchesManifest,
  assertAppliedMigrationsMatchManifest,
  loadMigrationManifest,
  type AppliedMigration,
} from './e2e/migration-manifest.js';
import { applyManifestMigration } from './e2e/migration-transaction.js';
import { assertPostgresRuntime, loadLockedPostgresRuntime } from './e2e/postgres-runtime.js';

const testDatabaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!testDatabaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const databaseName = decodeURIComponent(new URL(testDatabaseURL).pathname.slice(1));
if (!/^spott_ci_[a-f0-9]{32}_test$/u.test(databaseName)) {
  throw new Error(
    `Refusing to run PostGIS integration tests against non-test database: ${databaseName}`,
  );
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(repoRoot, 'database', 'migrations');
const apiDirectory = join(repoRoot, 'services', 'api');
const apiSourceDirectory = join(apiDirectory, 'src');
const workerDirectory = join(repoRoot, 'services', 'worker');
const workerCleanupSpecification = 'test/session-completion-cleanup.integration.test.ts';
const requestedSpecifications = process.argv.slice(2);
if (requestedSpecifications.includes('--all') && requestedSpecifications.length !== 1) {
  throw new Error('--all cannot be combined with explicit integration spec paths');
}
const runAll = requestedSpecifications[0] === '--all';
const apiSpecifications =
  runAll
    ? (await readdir(apiSourceDirectory, { recursive: true }))
        .filter((name) => name.endsWith('.integration.spec.ts'))
        .map((name) => join('src', name))
        .toSorted()
    : requestedSpecifications;
if (apiSpecifications.length === 0) throw new Error('At least one integration spec path is required');

const client = new Client({
  connectionString: testDatabaseURL,
  application_name: 'spott-postgis-test-migrator',
});
const lockedPostgresRuntime = loadLockedPostgresRuntime(join(repoRoot, 'ci/toolchain-lock.json'));
const migrationManifest = await loadMigrationManifest({
  manifestPath: join(repoRoot, 'database', 'migration-manifest.json'),
  migrationsDirectory,
});

async function applyMigrations(pass: 1 | 2): Promise<number> {
  const table = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  const applied = new Map<string, string>();
  let appliedRows: AppliedMigration[] = [];
  if (table.rows[0]?.exists) {
    const result = await client.query<AppliedMigration>(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
    );
    appliedRows = result.rows;
    for (const row of result.rows) applied.set(row.version, row.checksum);
  }
  assertAppliedMigrationPrefixMatchesManifest(appliedRows, migrationManifest);

  let appliedCount = 0;
  for (const migration of migrationManifest) {
    const filename = migration.filename;
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
    const existing = applied.get(filename);
    if (existing) {
      if (existing !== migration.sha256) {
        throw new Error(`Applied migration checksum changed: ${filename}`);
      }
      process.stdout.write(`[migration pass ${pass}] already applied ${filename}\n`);
      continue;
    }
    await applyManifestMigration(client, migration, sql);
    appliedCount += 1;
    process.stdout.write(`[migration pass ${pass}] applied ${filename}\n`);
  }

  const stored = await client.query<AppliedMigration>(
    'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
  );
  assertAppliedMigrationsMatchManifest(stored.rows, migrationManifest);
  process.stdout.write(
    `[migration pass ${pass}] verified immutable manifest (${migrationManifest.length} rows)\n`,
  );
  return appliedCount;
}

await client.connect();
let integrationLockHeld = false;
try {
  await client.query('SELECT pg_advisory_lock($1)', [8_672_026_071_501]);
  integrationLockHeld = true;
  await applyMigrations(1);
  const secondPassApplied = await applyMigrations(2);
  if (secondPassApplied !== 0) {
    throw new Error(`Migration pass 2 unexpectedly applied ${secondPassApplied} migration(s)`);
  }
  const postgres = await client.query<{ server_version: string }>('SHOW server_version');
  const postgis = await client.query<{ version: string }>(
    'SELECT postgis_full_version() AS version',
  );
  const serverVersion = postgres.rows[0]?.server_version;
  const postgisFullVersion = postgis.rows[0]?.version;
  if (!serverVersion || !postgisFullVersion) {
    throw new Error('POSTGRES_RUNTIME_UNAVAILABLE');
  }
  assertPostgresRuntime({ serverVersion, postgisFullVersion }, lockedPostgresRuntime);
  process.stdout.write('POSTGRES_RUNTIME_OK\n');
} finally {
  try {
    if (integrationLockHeld) {
      await client.query('SELECT pg_advisory_unlock($1)', [8_672_026_071_501]);
    }
  } finally {
    await client.end();
  }
}

const childEnvironment: NodeJS.ProcessEnv = {};
for (const key of ['CI', 'FORCE_COLOR', 'HOME', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR']) {
  const value = process.env[key];
  if (value !== undefined) childEnvironment[key] = value;
}

function runVitest(directory: string, arguments_: readonly string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', ...arguments_],
      {
        cwd: directory,
        env: {
          ...childEnvironment,
          NODE_ENV: 'test',
          DATABASE_URL: testDatabaseURL,
          SPOTT_TEST_DATABASE_URL: testDatabaseURL,
        },
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Vitest terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

const apiExitCode = await runVitest(apiDirectory, [
  '--config',
  'vitest.integration.config.ts',
  ...apiSpecifications,
]);
const workerExitCode = runAll
  ? await runVitest(workerDirectory, [workerCleanupSpecification])
  : 0;

process.exitCode = apiExitCode !== 0 ? apiExitCode : workerExitCode;
