import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const scanner = join(repositoryRoot, 'scripts/ci/scan-repository-secrets.mjs');

function git(root, ...arguments_) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spott-secret-scan-'));
  const allowlist = join(root, 'allowlist.json');
  writeFileSync(allowlist, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Spott CI Fixture');
  git(root, 'config', 'user.email', 'ci-fixture@spott.invalid');
  writeFileSync(join(root, 'README.md'), 'clean\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'clean seed');
  return { root, allowlist };
}

function run(paths, reportName = 'secret-report.json') {
  const report = join(paths.root, reportName);
  const result = spawnSync(
    process.execPath,
    [scanner, '--repo-root', paths.root, '--allowlist', paths.allowlist, '--report', report],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SECRET_SCAN_SENTINEL: 'MUST_NOT_PRINT_84F1A' },
    },
  );
  return { result, report };
}

test('finds a credential removed from the working tree but retained in Git history', () => {
  const paths = fixture();
  const credential = ['AK', 'IA', 'A'.repeat(16)].join('');
  writeFileSync(join(paths.root, 'historical.txt'), `${credential}\n`);
  git(paths.root, 'add', 'historical.txt');
  git(paths.root, 'commit', '-m', 'historical credential fixture');
  unlinkSync(join(paths.root, 'historical.txt'));
  git(paths.root, 'add', '-u');
  git(paths.root, 'commit', '-m', 'remove working-tree credential');

  const { result, report } = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'SECRET_SCAN_FINDINGS count=1\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.status, 'failure');
  assert.equal(parsed.scannedCommits, 3);
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(Object.keys(parsed.findings[0]).toSorted(), ['fingerprint', 'path', 'pattern']);
  assert.equal(parsed.findings[0].path, 'historical.txt');
  assert.equal(parsed.findings[0].pattern, 'aws_access_key');
  assert.match(parsed.findings[0].fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(readFileSync(report, 'utf8').includes(credential), false);
});

test('fails closed in a shallow repository instead of claiming full-history coverage', () => {
  const source = fixture();
  const credential = ['AK', 'IA', 'Z'.repeat(16)].join('');
  writeFileSync(join(source.root, 'historical.txt'), `${credential}\n`);
  git(source.root, 'add', 'historical.txt');
  git(source.root, 'commit', '-m', 'credential outside shallow boundary');
  unlinkSync(join(source.root, 'historical.txt'));
  git(source.root, 'add', '-u');
  git(source.root, 'commit', '-m', 'shallow tip without credential');

  const clone = join(mkdtempSync(join(tmpdir(), 'spott-secret-shallow-parent-')), 'clone');
  const cloned = spawnSync('git', ['clone', '--depth=1', `file://${source.root}`, clone], {
    encoding: 'utf8',
  });
  assert.equal(cloned.status, 0, cloned.stderr);
  const allowlist = join(clone, 'allowlist.json');
  writeFileSync(allowlist, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });

  const { result, report } = run({ root: clone, allowlist });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'SECRET_SCAN_HISTORY_INCOMPLETE\n');
  assert.equal(existsSync(report), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
});

test('a reviewed exact fingerprint can suppress only its matching finding', () => {
  const paths = fixture();
  const credential = ['ghp', '_', 'B'.repeat(40)].join('');
  writeFileSync(join(paths.root, 'fixture.txt'), `${credential}\n`);
  git(paths.root, 'add', 'fixture.txt');
  git(paths.root, 'commit', '-m', 'reviewable false-positive fixture');
  const first = run(paths, 'first-report.json');
  assert.notEqual(first.result.status, 0);
  const fingerprint = JSON.parse(readFileSync(first.report, 'utf8')).findings[0].fingerprint;
  writeFileSync(
    paths.allowlist,
    `${JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          fingerprint,
          reason: 'synthetic scanner regression fixture',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );

  const second = run(paths, 'second-report.json');
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.result.stdout, 'SECRET_SCAN_OK findings=0 allowlisted=1\n');
  const report = JSON.parse(readFileSync(second.report, 'utf8'));
  assert.equal(report.status, 'success');
  assert.deepEqual(report.findings, []);
  assert.equal(report.allowlistedCount, 1);
});

test('detects a private-key marker in the current tracked tree', () => {
  const paths = fixture();
  const marker = ['-----BEGIN ', 'PRIVATE', ' KEY-----'].join('');
  writeFileSync(join(paths.root, 'key.txt'), `${marker}\n`);
  git(paths.root, 'add', 'key.txt');

  const { result, report } = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(report, 'utf8')).findings[0].pattern, 'private_key');
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);
});

test('rejects an unreviewed allowlist shape and emits no report', () => {
  const paths = fixture();
  writeFileSync(paths.allowlist, '{"schemaVersion":1,"entries":[],"skipAll":true}\n');
  const { result, report } = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'SECRET_SCAN_ALLOWLIST_INVALID\n');
  assert.equal(existsSync(report), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT_84F1A'), false);
});

test('rejects expired or stale exceptions instead of silently widening the gate', async (t) => {
  await t.test('expired', () => {
    const paths = fixture();
    writeFileSync(
      paths.allowlist,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            fingerprint: 'a'.repeat(64),
            reason: 'expired synthetic exception',
            expiresAt: '2000-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
    );
    const { result, report } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'SECRET_SCAN_ALLOWLIST_EXPIRED\n');
    assert.equal(existsSync(report), false);
  });

  await t.test('stale fingerprint no longer matches any finding', () => {
    const paths = fixture();
    writeFileSync(
      paths.allowlist,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            fingerprint: 'b'.repeat(64),
            reason: 'stale synthetic exception',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      })}\n`,
    );
    const { result, report } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'SECRET_SCAN_ALLOWLIST_STALE\n');
    assert.equal(existsSync(report), false);
  });
});
