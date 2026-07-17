import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const writer = join(repositoryRoot, 'scripts/ci/create-evidence-artifact.mjs');

function run(...arguments_) {
  const root = mkdtempSync(join(tmpdir(), 'spott-evidence-artifact-'));
  const output = join(root, 'artifact');
  const result = spawnSync(
    process.execPath,
    [writer, '--output-directory', output, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CI_SECRET_SENTINEL: 'MUST_NOT_PRINT_82D37' },
    },
  );
  return { output, result };
}

test('writes a deterministic mode-safe evidence report and complete SHA manifest', () => {
  const { output, result } = run('--check', 'node-quality-shard', '--status', 'success');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'EVIDENCE_ARTIFACT_OK\n');

  const report = readFileSync(join(output, 'report.json'));
  assert.deepEqual(JSON.parse(report), {
    schemaVersion: 1,
    check: 'node-quality-shard',
    status: 'success',
  });
  assert.equal(
    readFileSync(join(output, 'artifact-manifest.sha256'), 'utf8'),
    `${createHash('sha256').update(report).digest('hex')}  report.json\n`,
  );
  assert.equal(lstatSync(output).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(output, 'report.json')).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(output, 'artifact-manifest.sha256')).mode & 0o777, 0o600);
});

for (const [name, arguments_] of [
  ['unsafe check name', ['--check', '../escape', '--status', 'success']],
  ['unknown status', ['--check', 'node-quality', '--status', 'unknown']],
  ['unknown argument', ['--check', 'node-quality', '--status', 'success', '--extra', 'x']],
]) {
  test(`fails closed for ${name} without printing environment values`, () => {
    const { result } = run(...arguments_);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^EVIDENCE_[A-Z_]+\n$/u);
    assert.equal(`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT_82D37'), false);
  });
}
