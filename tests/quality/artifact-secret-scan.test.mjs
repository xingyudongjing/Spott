import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const scanner = join(repositoryRoot, 'scripts/ci/scan-built-artifacts.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spott-artifact-scan-'));
  const artifacts = {};
  for (const name of ['api', 'ops', 'web', 'worker']) {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, 'index.js'), `console.log(${JSON.stringify(name)});\n`, {
      mode: 0o600,
    });
    artifacts[name] = directory;
  }
  const allowlist = join(root, 'allowlist.json');
  writeFileSync(allowlist, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });
  return { root, artifacts, allowlist };
}

function run(paths, options = {}) {
  const report = join(paths.root, options.reportName ?? 'artifact-report.json');
  const artifactArguments = [];
  for (const name of options.labels ?? ['api', 'ops', 'web', 'worker']) {
    artifactArguments.push('--artifact', `${name}=${paths.artifacts[name]}`);
  }
  const result = spawnSync(
    process.execPath,
    [scanner, '--allowlist', paths.allowlist, '--report', report, ...artifactArguments],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ARTIFACT_SCAN_SENTINEL: 'MUST_NOT_PRINT_5A90F3',
      },
    },
  );
  return { report, result };
}

test('scans the exact four product artifacts and writes a private redacted report', () => {
  const paths = fixture();
  const { report, result } = run(paths);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ARTIFACT_SCAN_OK artifacts=4 findings=0 allowlisted=0\n');
  assert.equal(result.stderr, '');
  assert.equal(lstatSync(report).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), {
    schemaVersion: 1,
    status: 'success',
    artifacts: [
      { name: 'api', files: 1, bytes: 20 },
      { name: 'ops', files: 1, bytes: 20 },
      { name: 'web', files: 1, bytes: 20 },
      { name: 'worker', files: 1, bytes: 23 },
    ],
    allowlistedCount: 0,
    findings: [],
  });
});

test('fails closed when a product artifact is missing, duplicated, unknown, or empty', async (t) => {
  for (const [label, mutate, expected] of [
    [
      'missing worker',
      (paths) => run(paths, { labels: ['api', 'ops', 'web'] }),
      'ARTIFACT_SCAN_ARGUMENTS_INVALID\n',
    ],
    [
      'duplicate api',
      (paths) => run(paths, { labels: ['api', 'api', 'ops', 'web', 'worker'] }),
      'ARTIFACT_SCAN_ARGUMENTS_INVALID\n',
    ],
    [
      'unknown label',
      (paths) => {
        paths.artifacts.extra = paths.artifacts.worker;
        return run(paths, { labels: ['api', 'ops', 'web', 'worker', 'extra'] });
      },
      'ARTIFACT_SCAN_ARGUMENTS_INVALID\n',
    ],
    [
      'empty artifact',
      (paths) => {
        paths.artifacts.worker = join(paths.root, 'empty-worker');
        mkdirSync(paths.artifacts.worker, { mode: 0o700 });
        return run(paths);
      },
      'ARTIFACT_SCAN_INPUT_INVALID\n',
    ],
  ]) {
    await t.test(label, () => {
      const paths = fixture();
      const { report, result } = mutate(paths);
      assert.notEqual(result.status, 0);
      assert.equal(result.stderr, expected);
      assert.equal(existsSync(report), false);
    });
  }
});

test('finds credential bytes inside a source map without echoing them', () => {
  const paths = fixture();
  const credential = ['ghp', '_', 'C'.repeat(40)].join('');
  writeFileSync(
    join(paths.artifacts.web, 'app.js.map'),
    JSON.stringify({
      version: 3,
      sources: ['src.ts'],
      sourcesContent: [`const token = '${credential}'`],
    }),
    { mode: 0o600 },
  );

  const { report, result } = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'ARTIFACT_SCAN_FINDINGS count=1\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.status, 'failure');
  assert.deepEqual(
    parsed.findings.map(({ artifact, path, pattern }) => ({ artifact, path, pattern })),
    [{ artifact: 'web', path: 'app.js.map', pattern: 'github_classic_token' }],
  );
  assert.deepEqual(Object.keys(parsed.findings[0]).toSorted(), [
    'artifact',
    'fingerprint',
    'path',
    'pattern',
  ]);
  assert.match(parsed.findings[0].fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(readFileSync(report, 'utf8').includes(credential), false);
});

test('finds embedded private connection strings and literal secret configuration', () => {
  const paths = fixture();
  const connection = ['postgres://app:', 'not-a-real-password', '@db.internal:5432/spott'].join('');
  const literal = ['"SESSION_SIGNING_SECRET_KEY":"', 'D'.repeat(40), '"'].join('');
  const environmentLiteral = ['SESSION_TOKEN_VALUE=', 'F'.repeat(40)].join('');
  writeFileSync(
    join(paths.artifacts.api, 'config.js'),
    `${connection}\n{${literal}}\n${environmentLiteral}\n`,
    { mode: 0o600 },
  );

  const { report, result } = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(connection), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('D'.repeat(40)), false);
  assert.deepEqual(
    JSON.parse(readFileSync(report, 'utf8'))
      .findings.map((finding) => finding.pattern)
      .toSorted(),
    ['credentialed_connection_uri', 'literal_private_config', 'literal_private_config'],
  );
});

test('an exact reviewed fingerprint suppresses only its matching artifact finding', () => {
  const paths = fixture();
  const credential = ['xoxb-', '1'.repeat(12), '-', 'G'.repeat(24)].join('');
  writeFileSync(join(paths.artifacts.ops, 'bundle.js'), credential, { mode: 0o600 });
  const first = run(paths, { reportName: 'first-report.json' });
  assert.notEqual(first.result.status, 0);
  const [finding] = JSON.parse(readFileSync(first.report, 'utf8')).findings;
  writeFileSync(
    paths.allowlist,
    `${JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          fingerprint: finding.fingerprint,
          reason: 'synthetic artifact scanner regression fixture',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );

  const second = run(paths, { reportName: 'second-report.json' });
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.result.stdout, 'ARTIFACT_SCAN_OK artifacts=4 findings=0 allowlisted=1\n');
  const report = JSON.parse(readFileSync(second.report, 'utf8'));
  assert.equal(report.status, 'success');
  assert.equal(report.allowlistedCount, 1);
  assert.deepEqual(report.findings, []);
  assert.equal(readFileSync(second.report, 'utf8').includes(credential), false);
});

test('rejects private configuration files and reports unsafe world-readable secret files', () => {
  const paths = fixture();
  const secretFile = join(paths.artifacts.worker, '.env.production');
  writeFileSync(secretFile, 'FEATURE_FLAG=true\n', { mode: 0o644 });
  chmodSync(secretFile, 0o644);

  const { report, result } = run(paths);
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(report, 'utf8'))
      .findings.map((finding) => finding.pattern)
      .toSorted(),
    ['private_config_file', 'world_readable_secret_file'],
  );
});

test('rejects symlink roots and nested symlinks without scanning their targets', async (t) => {
  await t.test('artifact root', () => {
    const paths = fixture();
    const link = join(paths.root, 'api-link');
    symlinkSync(paths.artifacts.api, link, 'dir');
    paths.artifacts.api = link;
    const { report, result } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'ARTIFACT_SCAN_INPUT_UNSAFE\n');
    assert.equal(existsSync(report), false);
  });

  await t.test('nested entry', () => {
    const paths = fixture();
    const outside = join(paths.root, 'outside.txt');
    const credential = ['sk', '_live_', 'E'.repeat(32)].join('');
    writeFileSync(outside, credential, { mode: 0o600 });
    symlinkSync(outside, join(paths.artifacts.ops, 'linked.js'));
    const { report, result } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'ARTIFACT_SCAN_INPUT_UNSAFE\n');
    assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
    assert.equal(existsSync(report), false);
  });
});

test('rejects malformed, expired, and stale exceptions instead of widening the gate', async (t) => {
  await t.test('malformed', () => {
    const paths = fixture();
    writeFileSync(paths.allowlist, '{"schemaVersion":1,"entries":[],"skip":true}\n', {
      mode: 0o600,
    });
    const { report, result } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'ARTIFACT_SCAN_ALLOWLIST_INVALID\n');
    assert.equal(existsSync(report), false);
  });

  await t.test('expired', () => {
    const paths = fixture();
    writeFileSync(
      paths.allowlist,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            fingerprint: 'a'.repeat(64),
            reason: 'expired artifact scanner fixture',
            expiresAt: '2000-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const { report, result } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'ARTIFACT_SCAN_ALLOWLIST_EXPIRED\n');
    assert.equal(existsSync(report), false);
  });

  await t.test('stale', () => {
    const paths = fixture();
    writeFileSync(
      paths.allowlist,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            fingerprint: 'b'.repeat(64),
            reason: 'stale artifact scanner fixture',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const { report, result } = run(paths);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, 'ARTIFACT_SCAN_ALLOWLIST_STALE\n');
    assert.equal(existsSync(report), false);
  });
});

test('never overwrites an existing report or emits environment values', () => {
  const paths = fixture();
  const report = join(paths.root, 'artifact-report.json');
  writeFileSync(report, 'operator-owned\n', { mode: 0o600 });
  const { result } = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'ARTIFACT_SCAN_REPORT_UNSAFE\n');
  assert.equal(readFileSync(report, 'utf8'), 'operator-owned\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT_5A90F3'), false);
});
