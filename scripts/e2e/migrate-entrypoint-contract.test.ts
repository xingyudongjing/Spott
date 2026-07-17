import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

void test('migration entrypoint verifies the immutable manifest before database mutation', async () => {
  const source = await readFile(resolve(repositoryRoot, 'scripts/migrate.ts'), 'utf8');
  assert.match(source, /loadMigrationManifest/u);
  assert.match(source, /applyManifestMigration/u);
  assert.match(source, /assertAppliedMigrationPrefixMatchesManifest/u);
  assert.match(source, /assertAppliedMigrationsMatchManifest/u);
  assert.doesNotMatch(source, /createHash|readdir/u);

  const load = source.indexOf('loadMigrationManifest(');
  const connect = source.indexOf('client.connect()');
  const prefix = source.indexOf('assertAppliedMigrationPrefixMatchesManifest(');
  const apply = source.indexOf('applyManifestMigration(');
  const complete = source.indexOf('assertAppliedMigrationsMatchManifest(');
  assert.ok(load >= 0 && connect > load, 'manifest bytes must verify before connecting');
  assert.ok(prefix >= 0 && apply > prefix, 'deployed prefix must verify before applying SQL');
  assert.ok(complete > apply, 'the complete database checksum set must verify after applying SQL');
});

void test('migration entrypoint resolves repository paths from its own module', async () => {
  const source = await readFile(resolve(repositoryRoot, 'scripts/migrate.ts'), 'utf8');
  assert.match(source, /import\.meta\.url/u);
  assert.doesNotMatch(source, /process\.cwd\(\)/u);
});

void test('test migration mode proves the current run registry and target marker before connect', async () => {
  const source = await readFile(resolve(repositoryRoot, 'scripts/migrate.ts'), 'utf8');
  assert.match(source, /SPOTT_DATABASE_OWNERSHIP_REQUIRED/u);
  assert.match(source, /createPostgresDatabaseOwnershipCoordinator/u);
  assert.match(source, /\.verifyReady\(\)/u);
  const proof = source.indexOf('await verifyRequestedDatabaseOwnership(databaseURL);');
  const connect = source.indexOf('client.connect()');
  assert.ok(proof >= 0 && connect > proof, 'ownership proof must finish before target connect');
});
