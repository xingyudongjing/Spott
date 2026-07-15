import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required');

const migrationsDirectory = join(process.cwd(), 'database', 'migrations');
const client = new Client({ connectionString: databaseURL });

await client.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [8_672_026_071_500]);
  const tableExists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  const applied = new Map<string, string>();
  if (tableExists.rows[0]?.exists) {
    const result = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
    );
    for (const row of result.rows) applied.set(row.version, row.checksum);
  }

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .toSorted();

  for (const filename of migrationFiles) {
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const currentChecksum = applied.get(filename);
    if (currentChecksum) {
      if (currentChecksum !== checksum) {
        throw new Error(`Deployed migration was modified: ${filename}`);
      }
      console.info(`skip ${filename}`);
      continue;
    }

    console.info(`apply ${filename}`);
    await client.query(sql);
    await client.query(
      'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)',
      [filename, checksum],
    );
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [8_672_026_071_500]).catch(() => undefined);
  await client.end();
}
