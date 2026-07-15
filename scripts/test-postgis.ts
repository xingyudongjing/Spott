import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

const testDatabaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!testDatabaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const databaseName = decodeURIComponent(new URL(testDatabaseURL).pathname.slice(1));
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to run PostGIS integration tests against non-test database: ${databaseName}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(repoRoot, 'database', 'migrations');
const apiDirectory = join(repoRoot, 'services', 'api');
const specifications = process.argv.slice(2);
if (specifications.length === 0) throw new Error('At least one integration spec path is required');

const client = new Client({ connectionString: testDatabaseURL, application_name: 'spott-postgis-test-migrator' });
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [8_672_026_071_501]);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .toSorted();
  const table = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  const applied = new Map<string, string>();
  if (table.rows[0]?.exists) {
    const result = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
    );
    for (const row of result.rows) applied.set(row.version, row.checksum);
  }

  for (const filename of migrationFiles) {
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = applied.get(filename);
    if (existing) {
      if (existing !== checksum) throw new Error(`Applied migration checksum changed: ${filename}`);
      continue;
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)',
      [filename, checksum],
    );
  }
  const postgis = await client.query<{ version: string }>('SELECT PostGIS_Version() AS version');
  if (!postgis.rows[0]?.version) throw new Error('PostGIS extension is unavailable');
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [8_672_026_071_501]).catch(() => undefined);
  await client.end();
}

const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...specifications],
    {
      cwd: apiDirectory,
      env: {
        ...process.env,
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

process.exitCode = exitCode;
