import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertAppliedMigrationPrefixMatchesManifest,
  assertAppliedMigrationsMatchManifest,
  loadMigrationManifest,
  type AppliedMigration,
} from './migration-manifest.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');

void test('loads and verifies the repository migration manifest against SQL bytes', async () => {
  const manifest = await loadMigrationManifest({
    manifestPath: join(repositoryRoot, 'database/migration-manifest.json'),
    migrationsDirectory: join(repositoryRoot, 'database/migrations'),
  });

  assert.ok(manifest.length >= 21);
  assert.equal(manifest[0]?.filename, '0001_platform.sql');
  assert.equal(manifest.at(-1)?.sequence, manifest.length);
});

void test('accepts only an exact ordered database checksum set', () => {
  const manifest = [
    { sequence: 1, filename: '0001_first.sql', sha256: 'a'.repeat(64) },
    { sequence: 2, filename: '0002_second.sql', sha256: 'b'.repeat(64) },
  ];
  const applied: AppliedMigration[] = [
    { version: '0001_first.sql', checksum: 'a'.repeat(64) },
    { version: '0002_second.sql', checksum: 'b'.repeat(64) },
  ];

  assert.doesNotThrow(() => assertAppliedMigrationsMatchManifest(applied, manifest));
  assert.doesNotThrow(() => assertAppliedMigrationPrefixMatchesManifest([], manifest));
  assert.doesNotThrow(() =>
    assertAppliedMigrationPrefixMatchesManifest(applied.slice(0, 1), manifest),
  );
  assert.doesNotThrow(() => assertAppliedMigrationPrefixMatchesManifest(applied, manifest));
});

void test('rejects a non-prefix database state before any new migration can run', () => {
  const manifest = [
    { sequence: 1, filename: '0001_first.sql', sha256: 'a'.repeat(64) },
    { sequence: 2, filename: '0002_second.sql', sha256: 'b'.repeat(64) },
  ];

  assert.throws(
    () =>
      assertAppliedMigrationPrefixMatchesManifest(
        [{ version: '0002_second.sql', checksum: 'b'.repeat(64) }],
        manifest,
      ),
    /MIGRATION_DATABASE_SET_MISMATCH/u,
  );
  assert.throws(
    () =>
      assertAppliedMigrationPrefixMatchesManifest(
        [{ version: '0001_first.sql', checksum: 'c'.repeat(64) }],
        manifest,
      ),
    /MIGRATION_DATABASE_CHECKSUM_MISMATCH/u,
  );
  assert.throws(
    () =>
      assertAppliedMigrationPrefixMatchesManifest(
        [
          { version: '0001_first.sql', checksum: 'a'.repeat(64) },
          { version: '0002_second.sql', checksum: 'b'.repeat(64) },
          { version: '9999_unlisted.sql', checksum: 'c'.repeat(64) },
        ],
        manifest,
      ),
    /MIGRATION_DATABASE_SET_MISMATCH/u,
  );
});

void test('rejects missing, extra, reordered, or stale database migration rows', async (t) => {
  const manifest = [
    { sequence: 1, filename: '0001_first.sql', sha256: 'a'.repeat(64) },
    { sequence: 2, filename: '0002_second.sql', sha256: 'b'.repeat(64) },
  ];
  const exact: AppliedMigration[] = [
    { version: '0001_first.sql', checksum: 'a'.repeat(64) },
    { version: '0002_second.sql', checksum: 'b'.repeat(64) },
  ];

  await t.test('missing', () => {
    assert.throws(
      () => assertAppliedMigrationsMatchManifest(exact.slice(0, 1), manifest),
      /MIGRATION_DATABASE_SET_MISMATCH/u,
    );
  });
  await t.test('extra', () => {
    assert.throws(
      () =>
        assertAppliedMigrationsMatchManifest(
          [...exact, { version: '9999_unlisted.sql', checksum: 'c'.repeat(64) }],
          manifest,
        ),
      /MIGRATION_DATABASE_SET_MISMATCH/u,
    );
  });
  await t.test('reordered', () => {
    assert.throws(
      () => assertAppliedMigrationsMatchManifest(exact.toReversed(), manifest),
      /MIGRATION_DATABASE_SET_MISMATCH/u,
    );
  });
  await t.test('stale checksum', () => {
    assert.throws(
      () =>
        assertAppliedMigrationsMatchManifest(
          [exact[0]!, { version: '0002_second.sql', checksum: 'c'.repeat(64) }],
          manifest,
        ),
      /MIGRATION_DATABASE_CHECKSUM_MISMATCH/u,
    );
  });
});
