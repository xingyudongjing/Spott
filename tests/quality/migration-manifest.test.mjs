import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const verifier = join(repositoryRoot, 'scripts/ci/verify-migration-manifest.mjs');
const repositoryManifest = join(repositoryRoot, 'database/migration-manifest.json');
const schema = join(repositoryRoot, 'database/migration-manifest.schema.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function manifestRow(sequence, filename, contents) {
  return { sequence, filename, sha256: sha256(contents) };
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
    { mode: 0o600 },
  );
}

function fixture(rows = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'spott-migration-manifest-'));
  const migrationsDirectory = join(root, 'database/migrations');
  mkdirSync(migrationsDirectory, { recursive: true });
  const defaults = rows ?? [
    { sequence: 1, filename: '0001_first.sql', contents: 'SELECT 1;\n' },
    { sequence: 2, filename: '0002_second.sql', contents: 'SELECT 2;\n' },
  ];
  for (const row of defaults) {
    writeFileSync(join(migrationsDirectory, row.filename), row.contents, { mode: 0o600 });
  }
  const manifest = join(root, 'database/migration-manifest.json');
  const fixtureSchema = join(root, 'database/migration-manifest.schema.json');
  mkdirSync(dirname(manifest), { recursive: true });
  cpSync(schema, fixtureSchema);
  writeManifest(
    manifest,
    defaults.map((row) => manifestRow(row.sequence, row.filename, row.contents)),
  );
  return { root, migrationsDirectory, manifest, schema: fixtureSchema, rows: defaults };
}

function runVerifier({
  manifest,
  schema: schemaPath,
  migrationsDirectory,
  baseManifest,
  baseRef,
  repoRoot,
} = {}) {
  const arguments_ = [
    verifier,
    '--manifest',
    manifest ?? repositoryManifest,
    '--schema',
    schemaPath ?? schema,
    '--migrations-dir',
    migrationsDirectory ?? join(repositoryRoot, 'database/migrations'),
  ];
  if (baseManifest) arguments_.push('--base-manifest', baseManifest);
  if (baseRef) arguments_.push('--base-ref', baseRef, '--repo-root', repoRoot);
  return spawnSync(process.execPath, arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
}

function git(root, arguments_) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${arguments_.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function expectRejected(result, code) {
  assert.notEqual(result.status, 0, `expected failure, stdout=${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`\\b${code}\\b`, 'u'));
}

test('repository migration manifest exactly covers every current SQL migration', () => {
  const result = runVerifier();
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /MIGRATION_MANIFEST_OK/u);
});

test('accepts a strictly contiguous append while preserving the complete base prefix', () => {
  const current = fixture();
  const baseManifest = join(current.root, 'base-manifest.json');
  writeManifest(
    baseManifest,
    current.rows.slice(0, 1).map((row) => manifestRow(row.sequence, row.filename, row.contents)),
  );

  const result = runVerifier({ ...current, baseManifest });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('loads the immutable base manifest from an exact full git commit', async (t) => {
  const current = fixture([{ sequence: 1, filename: '0001_first.sql', contents: 'SELECT 1;\n' }]);
  git(current.root, ['init', '-b', 'main']);
  git(current.root, ['config', 'user.name', 'Spott CI Fixture']);
  git(current.root, ['config', 'user.email', 'ci-fixture@spott.invalid']);
  git(current.root, ['add', 'database']);
  git(current.root, ['commit', '-m', 'seed migration manifest']);
  const baseRef = git(current.root, ['rev-parse', 'HEAD']);

  writeFileSync(join(current.migrationsDirectory, '0002_second.sql'), 'SELECT 2;\n');
  writeManifest(current.manifest, [
    manifestRow(1, '0001_first.sql', 'SELECT 1;\n'),
    manifestRow(2, '0002_second.sql', 'SELECT 2;\n'),
  ]);

  await t.test('accepts the exact base SHA', () => {
    const result = runVerifier({ ...current, baseRef, repoRoot: current.root });
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  });

  await t.test('rejects an abbreviated base SHA', () => {
    expectRejected(
      runVerifier({ ...current, baseRef: baseRef.slice(0, 12), repoRoot: current.root }),
      'BASE_REF_INVALID',
    );
  });
});

test('rejects deletion, rename, edits, gaps, unlisted files, and unknown fields', async (t) => {
  await t.test('old manifest row edited with matching current SQL', () => {
    const current = fixture();
    const baseManifest = join(current.root, 'base-manifest.json');
    writeManifest(
      baseManifest,
      current.rows.map((row) => manifestRow(row.sequence, row.filename, row.contents)),
    );
    const changed = 'SELECT 999;\n';
    writeFileSync(join(current.migrationsDirectory, '0001_first.sql'), changed);
    writeManifest(current.manifest, [
      manifestRow(1, '0001_first.sql', changed),
      manifestRow(2, '0002_second.sql', 'SELECT 2;\n'),
    ]);
    expectRejected(runVerifier({ ...current, baseManifest }), 'BASE_MIGRATION_CHANGED');
  });

  await t.test('old manifest row renamed', () => {
    const current = fixture();
    const baseManifest = join(current.root, 'base-manifest.json');
    writeManifest(
      baseManifest,
      current.rows.map((row) => manifestRow(row.sequence, row.filename, row.contents)),
    );
    writeManifest(current.manifest, [
      manifestRow(1, '0001_renamed.sql', 'SELECT 1;\n'),
      manifestRow(2, '0002_second.sql', 'SELECT 2;\n'),
    ]);
    expectRejected(runVerifier({ ...current, baseManifest }), 'BASE_MIGRATION_CHANGED');
  });

  await t.test('old row deleted', () => {
    const current = fixture();
    const baseManifest = join(current.root, 'base-manifest.json');
    writeManifest(
      baseManifest,
      current.rows.map((row) => manifestRow(row.sequence, row.filename, row.contents)),
    );
    writeManifest(current.manifest, [manifestRow(1, '0001_first.sql', 'SELECT 1;\n')]);
    expectRejected(runVerifier({ ...current, baseManifest }), 'BASE_MIGRATION_DELETED');
  });

  await t.test('sequence gap', () => {
    const current = fixture([
      { sequence: 1, filename: '0001_first.sql', contents: 'SELECT 1;\n' },
      { sequence: 3, filename: '0003_third.sql', contents: 'SELECT 3;\n' },
    ]);
    expectRejected(runVerifier(current), 'SEQUENCE_NOT_CONTIGUOUS');
  });

  await t.test('unlisted SQL migration', () => {
    const current = fixture();
    writeFileSync(join(current.migrationsDirectory, '0003_unlisted.sql'), 'SELECT 3;\n');
    expectRejected(runVerifier(current), 'MIGRATION_SET_MISMATCH');
  });

  await t.test('unknown manifest field', () => {
    const current = fixture();
    const parsed = JSON.parse(readFileSync(current.manifest, 'utf8'));
    parsed.unreviewed = true;
    writeFileSync(current.manifest, `${JSON.stringify(parsed)}\n`);
    expectRejected(runVerifier(current), 'MANIFEST_INVALID');
  });
});

test('rejects a stale checksum even when the filename and sequence still match', () => {
  const current = fixture();
  writeFileSync(join(current.migrationsDirectory, '0002_second.sql'), 'SELECT 222;\n');
  expectRejected(runVerifier(current), 'MIGRATION_HASH_MISMATCH');
});

test('rejects duplicate, path-escaping, symlink, and malformed migration entries', async (t) => {
  await t.test('duplicate sequence', () => {
    const current = fixture();
    writeManifest(current.manifest, [
      manifestRow(1, '0001_first.sql', 'SELECT 1;\n'),
      manifestRow(1, '0001_first.sql', 'SELECT 1;\n'),
    ]);
    expectRejected(runVerifier(current), 'MANIFEST_INVALID');
  });

  await t.test('path escape', () => {
    const current = fixture();
    writeManifest(current.manifest, [manifestRow(1, '../escape.sql', 'SELECT 1;\n')]);
    expectRejected(runVerifier(current), 'MANIFEST_INVALID');
  });

  await t.test('symlink migration', () => {
    const current = fixture();
    unlinkSync(join(current.migrationsDirectory, '0001_first.sql'));
    symlinkSync('0002_second.sql', join(current.migrationsDirectory, '0001_first.sql'));
    expectRejected(runVerifier(current), 'MIGRATION_FILE_UNSAFE');
  });

  await t.test('malformed filename/sequence pairing', () => {
    const current = fixture();
    writeManifest(current.manifest, [manifestRow(1, '0002_wrong.sql', 'SELECT 1;\n')]);
    expectRejected(runVerifier(current), 'MANIFEST_INVALID');
  });
});
