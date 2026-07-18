import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  applyManifestMigration,
  unwrapManifestMigrationTransaction,
  unwrapMigrationTransaction,
  type MigrationTransactionClient,
} from './migration-transaction.js';

class RecordingClient implements MigrationTransactionClient {
  readonly queries: { text: string; values: unknown[] | undefined }[] = [];
  failOn: string | undefined;

  async query(text: string, values?: unknown[]): Promise<unknown> {
    this.queries.push({ text, values });
    if (this.failOn === text) throw new Error('INJECTED_DATABASE_FAILURE');
    return {};
  }
}

const migration = {
  sequence: 1,
  filename: '0001_first.sql',
  sha256: 'a'.repeat(64),
};
const wrappedSQL = '-- immutable migration\nBEGIN;\n\nCREATE TABLE example(id uuid);\n\nCOMMIT;\n';
const expectedBody = '-- immutable migration\n\nCREATE TABLE example(id uuid);\n\n';
const repositoryRoot = resolve(import.meta.dirname, '../..');

void test('every repository migration is safe for the runner-owned transaction', async () => {
  const migrationsDirectory = join(repositoryRoot, 'database', 'migrations');
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, 'database', 'migration-manifest.json'), 'utf8'),
  ) as { migrations: { sequence: number; filename: string; sha256: string }[] };
  assert.ok(manifest.migrations.length >= 21);
  for (const row of manifest.migrations) {
    const sql = await readFile(join(migrationsDirectory, row.filename), 'utf8');
    assert.doesNotThrow(() => unwrapManifestMigrationTransaction(row, sql), row.filename);
  }
});

void test('accepts only the byte-exact legacy unwrapped promotion migration', async () => {
  const legacy = {
    sequence: 26,
    filename: '0026_event_promotion.sql',
    sha256: 'a2196808c41b380cc243fa19497f84fcc82b7ab18951cbe2e032e284787e7d58',
  };
  const sql = await readFile(
    join(repositoryRoot, 'database', 'migrations', legacy.filename),
    'utf8',
  );

  assert.throws(() => unwrapMigrationTransaction(sql), /MIGRATION_TRANSACTION_ENVELOPE_INVALID/u);
  assert.equal(unwrapManifestMigrationTransaction(legacy, sql), sql);
  assert.throws(
    () => unwrapManifestMigrationTransaction({ ...legacy, filename: '0026_other.sql' }, sql),
    /MIGRATION_TRANSACTION_ENVELOPE_INVALID/u,
  );
  assert.throws(
    () => unwrapManifestMigrationTransaction({ ...legacy, sha256: 'b'.repeat(64) }, sql),
    /MIGRATION_TRANSACTION_ENVELOPE_INVALID/u,
  );
  assert.throws(
    () => unwrapManifestMigrationTransaction(legacy, `${sql}\n-- changed`),
    /MIGRATION_TRANSACTION_ENVELOPE_INVALID/u,
  );
});

void test('unwraps exactly one outer migration transaction without changing its body', () => {
  assert.equal(unwrapMigrationTransaction(wrappedSQL), expectedBody);
});

void test('rejects missing, duplicate, nested, or trailing transaction control', () => {
  for (const sql of [
    'CREATE TABLE example(id uuid);',
    'BEGIN;\nCREATE TABLE example(id uuid);',
    'BEGIN;\nBEGIN;\nCOMMIT;\nCOMMIT;',
    'BEGIN;\nCOMMIT;\nSELECT 1;',
    'COMMIT;\nBEGIN;',
  ]) {
    assert.throws(() => unwrapMigrationTransaction(sql), /MIGRATION_TRANSACTION_ENVELOPE_INVALID/u);
  }
});

void test('commits migration bytes and immutable ledger row in one runner-owned transaction', async () => {
  const client = new RecordingClient();
  await applyManifestMigration(client, migration, wrappedSQL);

  assert.deepEqual(client.queries, [
    { text: 'BEGIN', values: undefined },
    {
      text: expectedBody,
      values: undefined,
    },
    {
      text: 'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)',
      values: [migration.filename, migration.sha256],
    },
    { text: 'COMMIT', values: undefined },
  ]);
});

void test('rolls back both schema and ledger when migration or ledger insertion fails', async (t) => {
  const body = unwrapMigrationTransaction(wrappedSQL);
  await t.test('migration body', async () => {
    const client = new RecordingClient();
    client.failOn = body;
    await assert.rejects(
      applyManifestMigration(client, migration, wrappedSQL),
      /INJECTED_DATABASE_FAILURE/u,
    );
    assert.deepEqual(
      client.queries.map(({ text }) => text),
      ['BEGIN', body, 'ROLLBACK'],
    );
  });
  await t.test('ledger insert', async () => {
    const client = new RecordingClient();
    client.failOn = 'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)';
    await assert.rejects(
      applyManifestMigration(client, migration, wrappedSQL),
      /INJECTED_DATABASE_FAILURE/u,
    );
    assert.deepEqual(
      client.queries.map(({ text }) => text),
      [
        'BEGIN',
        body,
        'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)',
        'ROLLBACK',
      ],
    );
  });
});
