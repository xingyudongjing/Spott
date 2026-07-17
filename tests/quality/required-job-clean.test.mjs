import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const cleaner = join(repositoryRoot, 'scripts/ci/prepare-required-job.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spott-required-job-clean-'));
  for (const path of [
    '.turbo/cache/item',
    'DerivedData/build/item',
    'output/playwright/item',
    'apps/web/.next/item',
    'apps/ops/dist/item',
    'services/api/dist/item',
    'services/worker/dist/item',
    'packages/api-client/dist/item',
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'stale\n');
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/keep.ts'), 'must remain\n');
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [cleaner, '--repo-root', root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CLEAN_SECRET_SENTINEL: 'MUST_NOT_PRINT_A7201' },
  });
}

test('removes only the reviewed build and test output allowlist', () => {
  const root = fixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^REQUIRED_JOB_PREPARED removed=8\n$/u);
  for (const path of [
    '.turbo',
    'DerivedData',
    'output',
    'apps/web/.next',
    'apps/ops/dist',
    'services/api/dist',
    'services/worker/dist',
    'packages/api-client/dist',
  ]) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
  assert.equal(readFileSync(join(root, 'src/keep.ts'), 'utf8'), 'must remain\n');
});

test('refuses an allowlisted symlink and preserves its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'spott-required-job-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'spott-required-job-outside-'));
  writeFileSync(join(outside, 'keep'), 'outside\n');
  symlinkSync(outside, join(root, 'output'));

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'REQUIRED_JOB_OUTPUT_UNSAFE\n');
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside\n');
});

test('rejects unknown arguments without printing environment values', () => {
  const result = spawnSync(
    process.execPath,
    [cleaner, '--repo-root', fixture(), '--extra', 'value'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLEAN_SECRET_SENTINEL: 'MUST_NOT_PRINT_A7201' },
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'REQUIRED_JOB_ARGUMENTS_INVALID\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT_A7201'), false);
});
