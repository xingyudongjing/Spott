#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const patterns = [
  {
    id: 'private_key',
    expression: '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  },
  { id: 'aws_access_key', expression: '(AKIA|ASIA)[0-9A-Z]{16}' },
  { id: 'github_classic_token', expression: 'gh[pousr]_[A-Za-z0-9]{36,}' },
  { id: 'github_fine_grained_token', expression: 'github_pat_[A-Za-z0-9_]{40,}' },
  { id: 'stripe_live_secret', expression: 'sk_live_[A-Za-z0-9]{20,}' },
  { id: 'slack_token', expression: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
];

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || values.has(flag)) {
      fail('SECRET_SCAN_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  const required = ['--allowlist', '--repo-root', '--report'];
  if (values.size !== required.length || required.some((flag) => !values.has(flag))) {
    fail('SECRET_SCAN_ARGUMENTS_INVALID');
  }
  const suppliedRoot = resolve(values.get('--repo-root'));
  const rootMetadata = lstatSync(suppliedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('SECRET_SCAN_INPUT_UNSAFE');
  }
  return {
    repositoryRoot: realpathSync(suppliedRoot),
    allowlistPath: resolve(values.get('--allowlist')),
    reportPath: resolve(values.get('--report')),
  };
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function readAllowlist(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
    fail('SECRET_SCAN_ALLOWLIST_INVALID');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('SECRET_SCAN_ALLOWLIST_INVALID');
  }
  if (
    !exactKeys(parsed, ['entries', 'schemaVersion']) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    fail('SECRET_SCAN_ALLOWLIST_INVALID');
  }
  const fingerprints = new Map();
  const now = Date.now();
  const maximumExpiry = now + 90 * 24 * 60 * 60 * 1000;
  for (const entry of parsed.entries) {
    if (
      !exactKeys(entry, ['expiresAt', 'fingerprint', 'reason']) ||
      typeof entry.fingerprint !== 'string' ||
      !fingerprintPattern.test(entry.fingerprint) ||
      fingerprints.has(entry.fingerprint) ||
      typeof entry.reason !== 'string' ||
      entry.reason.length < 10 ||
      entry.reason.length > 240 ||
      /[\u0000-\u001f\u007f]/u.test(entry.reason) ||
      typeof entry.expiresAt !== 'string'
    ) {
      fail('SECRET_SCAN_ALLOWLIST_INVALID');
    }
    const expiration = Date.parse(entry.expiresAt);
    if (
      !Number.isFinite(expiration) ||
      new Date(expiration).toISOString() !== entry.expiresAt ||
      expiration > maximumExpiry
    ) {
      fail('SECRET_SCAN_ALLOWLIST_INVALID');
    }
    if (expiration <= now) fail('SECRET_SCAN_ALLOWLIST_EXPIRED');
    fingerprints.set(entry.fingerprint, entry);
  }
  return fingerprints;
}

function git(repositoryRoot, arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null || result.status > 1) {
    fail('SECRET_SCAN_GIT_FAILED');
  }
  return result;
}

function commits(repositoryRoot) {
  const shallow = git(repositoryRoot, ['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0 || shallow.stdout !== 'false\n') {
    fail('SECRET_SCAN_HISTORY_INCOMPLETE');
  }
  const result = git(repositoryRoot, ['rev-list', '--all']);
  if (result.status !== 0) fail('SECRET_SCAN_GIT_FAILED');
  return result.stdout.split('\n').filter(Boolean);
}

function fingerprint(path, pattern, line) {
  const lineHash = createHash('sha256').update(line).digest('hex');
  return createHash('sha256')
    .update(path)
    .update('\u0000')
    .update(pattern)
    .update('\u0000')
    .update(lineHash)
    .digest('hex');
}

function recordMatches(output, pattern, historical, findings) {
  for (const line of output.split('\n')) {
    if (!line) continue;
    const match = historical
      ? /^[a-f0-9]{40}:(.*):([0-9]+):(.*)$/u.exec(line)
      : /^(.*):([0-9]+):(.*)$/u.exec(line);
    if (!match) fail('SECRET_SCAN_GIT_OUTPUT_INVALID');
    const path = match[1];
    const contents = match[3];
    const key = fingerprint(path, pattern.id, contents);
    findings.set(key, { fingerprint: key, path, pattern: pattern.id });
  }
}

function scan(repositoryRoot, commitList) {
  const findings = new Map();
  for (const pattern of patterns) {
    const working = git(repositoryRoot, [
      'grep',
      '-I',
      '-n',
      '--full-name',
      '-E',
      '-e',
      pattern.expression,
      '--',
    ]);
    if (working.status === 0) recordMatches(working.stdout, pattern, false, findings);

    for (let index = 0; index < commitList.length; index += 50) {
      const batch = commitList.slice(index, index + 50);
      const historical = git(repositoryRoot, [
        'grep',
        '-I',
        '-n',
        '--full-name',
        '-E',
        '-e',
        pattern.expression,
        ...batch,
        '--',
      ]);
      if (historical.status === 0) {
        recordMatches(historical.stdout, pattern, true, findings);
      }
    }
  }
  return findings;
}

function writeReport(path, report) {
  const parent = dirname(path);
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    fail('SECRET_SCAN_REPORT_UNSAFE');
  }
  writeFileSync(path, `${JSON.stringify(report)}\n`, { flag: 'wx', mode: 0o600 });
}

try {
  const options = parseArguments(process.argv.slice(2));
  const allowlist = readAllowlist(options.allowlistPath);
  const commitList = commits(options.repositoryRoot);
  const discovered = scan(options.repositoryRoot, commitList);
  for (const fingerprint of allowlist.keys()) {
    if (!discovered.has(fingerprint)) fail('SECRET_SCAN_ALLOWLIST_STALE');
  }
  let allowlistedCount = 0;
  const findings = [];
  for (const [key, finding] of [...discovered.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (allowlist.has(key)) allowlistedCount += 1;
    else findings.push(finding);
  }
  writeReport(options.reportPath, {
    schemaVersion: 1,
    status: findings.length === 0 ? 'success' : 'failure',
    scannedCommits: commitList.length,
    allowlistedCount,
    findings,
  });
  if (findings.length > 0) {
    process.stderr.write(`SECRET_SCAN_FINDINGS count=${findings.length}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`SECRET_SCAN_OK findings=0 allowlisted=${allowlistedCount}\n`);
  }
} catch (error) {
  const code =
    error instanceof Error && /^SECRET_SCAN_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'SECRET_SCAN_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
