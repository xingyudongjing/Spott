import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const verifier = join(repositoryRoot, 'scripts/ci/verify-aggregator.mjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spott-aggregator-test-'));
  const artifacts = join(root, 'artifacts');
  const output = join(root, 'output');
  mkdirSync(artifacts);
  for (const name of ['contracts-shard', 'node-shard']) {
    const directory = join(artifacts, name);
    const report = JSON.stringify({ schemaVersion: 1, shard: name, status: 'success' });
    mkdirSync(directory);
    writeFileSync(join(directory, 'report.json'), report);
    writeFileSync(join(directory, 'artifact-manifest.sha256'), `${sha256(report)}  report.json\n`);
  }
  return { root, artifacts, output };
}

function needs(overrides = {}) {
  return {
    contracts: {
      result: 'success',
      outputs: { 'artifact-name': 'contracts-shard' },
    },
    node: {
      result: 'success',
      outputs: { 'artifact-name': 'node-shard' },
    },
    ...overrides,
  };
}

function run(fixturePaths, needsValue = needs(), expected = 'contracts,node') {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--expected-needs',
      expected,
      '--artifacts-root',
      fixturePaths.artifacts,
      '--output-directory',
      fixturePaths.output,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SPOTT_NEEDS_JSON: JSON.stringify(needsValue) },
    },
  );
}

void test('accepts exact successful needs and verifies every artifact byte', () => {
  const paths = fixture();
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^AGGREGATOR_OK needs=2\n$/u);

  const status = JSON.parse(readFileSync(join(paths.output, 'aggregator-status.json'), 'utf8'));
  assert.deepEqual(status, {
    schemaVersion: 1,
    status: 'success',
    needs: ['contracts', 'node'],
  });
  const statusBytes = readFileSync(join(paths.output, 'aggregator-status.json'));
  assert.equal(
    readFileSync(join(paths.output, 'artifact-manifest.sha256'), 'utf8'),
    `${sha256(statusBytes)}  aggregator-status.json\n`,
  );
});

void test('fails closed for failure, cancelled, skipped, missing, or unexpected needs', async (t) => {
  for (const state of ['failure', 'cancelled', 'skipped']) {
    await t.test(state, () => {
      const result = run(fixture(), needs({ node: { result: state, outputs: {} } }));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /AGGREGATOR_NEED_NOT_SUCCESS/u);
    });
  }
  await t.test('missing', () => {
    const value = needs();
    delete value.node;
    const result = run(fixture(), value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_NEEDS_SET_MISMATCH/u);
  });
  await t.test('unexpected', () => {
    const result = run(
      fixture(),
      needs({ extra: { result: 'success', outputs: { 'artifact-name': 'extra' } } }),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_NEEDS_SET_MISMATCH/u);
  });
});

void test('rejects missing, malformed, stale, incomplete, or unsafe artifact manifests', async (t) => {
  await t.test('missing artifact directory', () => {
    const paths = fixture();
    rmSync(join(paths.artifacts, 'node-shard'), { recursive: true });
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_ARTIFACT_SET_MISMATCH/u);
  });
  await t.test('stale hash', () => {
    const paths = fixture();
    writeFileSync(join(paths.artifacts, 'contracts-shard', 'report.json'), 'changed');
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_ARTIFACT_HASH_MISMATCH/u);
    assert.equal(result.stderr.includes('changed'), false);
  });
  await t.test('unlisted file', () => {
    const paths = fixture();
    writeFileSync(join(paths.artifacts, 'node-shard', 'unlisted.txt'), 'not covered');
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_ARTIFACT_SET_MISMATCH/u);
  });
  await t.test('path traversal', () => {
    const paths = fixture();
    writeFileSync(
      join(paths.artifacts, 'node-shard', 'artifact-manifest.sha256'),
      `${'a'.repeat(64)}  ../outside\n`,
    );
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_MANIFEST_INVALID/u);
  });
  await t.test('symlink', () => {
    const paths = fixture();
    const directory = join(paths.artifacts, 'node-shard');
    symlinkSync('report.json', join(directory, 'alias.json'));
    writeFileSync(
      join(directory, 'artifact-manifest.sha256'),
      `${sha256(readFileSync(join(directory, 'report.json')))}  report.json\n${sha256(
        readFileSync(join(directory, 'report.json')),
      )}  alias.json\n`,
    );
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_ARTIFACT_UNSAFE/u);
  });
  await t.test('world-writable manifest', () => {
    const paths = fixture();
    const manifest = join(paths.artifacts, 'node-shard', 'artifact-manifest.sha256');
    chmodSync(manifest, 0o666);
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGGREGATOR_ARTIFACT_UNSAFE/u);
  });
});
