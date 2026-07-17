import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const wrapper = join(repositoryRoot, 'scripts/ci/verify-migrations-for-event.mjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(root, ...arguments_) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeManifest(path, rows) {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $schema: './migration-manifest.schema.json',
        schemaVersion: 1,
        migrations: rows,
      },
      null,
      2,
    )}\n`,
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spott-migration-event-'));
  const migrations = join(root, 'database/migrations');
  const manifest = join(root, 'database/migration-manifest.json');
  mkdirSync(migrations, { recursive: true });
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  copyFileSync(
    join(repositoryRoot, 'database/migration-manifest.schema.json'),
    join(root, 'database/migration-manifest.schema.json'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts/ci/verify-migration-manifest.mjs'),
    join(root, 'scripts/ci/verify-migration-manifest.mjs'),
  );
  const first = 'BEGIN;\nSELECT 1;\nCOMMIT;\n';
  writeFileSync(join(migrations, '0001_first.sql'), first);
  writeManifest(manifest, [{ sequence: 1, filename: '0001_first.sql', sha256: sha256(first) }]);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Spott CI Fixture');
  git(root, 'config', 'user.email', 'ci-fixture@spott.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'seed immutable migration');
  const baseSHA = git(root, 'rev-parse', 'HEAD');

  const second = 'BEGIN;\nSELECT 2;\nCOMMIT;\n';
  writeFileSync(join(migrations, '0002_second.sql'), second);
  writeManifest(manifest, [
    { sequence: 1, filename: '0001_first.sql', sha256: sha256(first) },
    { sequence: 2, filename: '0002_second.sql', sha256: sha256(second) },
  ]);
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, `${JSON.stringify({ pull_request: { base: { sha: baseSHA } } })}\n`);
  return { root, migrations, manifest, baseSHA, eventPath };
}

function run(paths) {
  return spawnSync(
    process.execPath,
    [
      wrapper,
      '--event-name',
      'pull_request',
      '--event-path',
      paths.eventPath,
      '--head-sha',
      '6'.repeat(40),
      '--repo-root',
      paths.root,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

test('event wrapper accepts only a contiguous append over the exact event base SHA', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^MIGRATION_MANIFEST_OK count=2\n$/u);
});

test('event wrapper rejects a rewritten base migration', () => {
  const paths = fixture();
  const changed = 'BEGIN;\nSELECT 999;\nCOMMIT;\n';
  writeFileSync(join(paths.migrations, '0001_first.sql'), changed);
  const current = JSON.parse(readFileSync(paths.manifest, 'utf8'));
  current.migrations[0].sha256 = sha256(changed);
  writeFileSync(paths.manifest, `${JSON.stringify(current, null, 2)}\n`);

  const result = run(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BASE_MIGRATION_CHANGED/u);
});
