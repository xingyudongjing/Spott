#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const expectedArtifacts = ['api', 'ops', 'web', 'worker'];
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const maximumFileBytes = 256 * 1024 * 1024;

const contentPatterns = [
  {
    id: 'private_key',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
  { id: 'aws_access_key', expression: /(?:AKIA|ASIA)[0-9A-Z]{16}/gu },
  { id: 'github_classic_token', expression: /gh[pousr]_[A-Za-z0-9]{36,}/gu },
  {
    id: 'github_fine_grained_token',
    expression: /github_pat_[A-Za-z0-9_]{40,}/gu,
  },
  { id: 'stripe_live_secret', expression: /sk_live_[A-Za-z0-9]{20,}/gu },
  { id: 'slack_token', expression: /xox[baprs]-[A-Za-z0-9-]{10,}/gu },
  {
    id: 'credentialed_connection_uri',
    expression:
      /(?:postgres(?:ql)?|mysql|redis|amqps?|mongodb(?:\+srv)?):\/\/[^/\s:@]+:[^@\s/]{4,}@/giu,
  },
  {
    id: 'literal_private_config',
    expression:
      /["'](?=[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL))[A-Z][A-Z0-9_]*["']\s*:\s*(?:"[^"\\\r\n]{8,}"|'[^'\\\r\n]{8,}')/gu,
  },
  {
    id: 'literal_private_config',
    expression:
      /(?:^|[\r\n])\s*(?:export\s+)?(?=[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL))[A-Z][A-Z0-9_]*\s*=\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s#\r\n]{8,})/gmu,
  },
];

const privateFilePatterns = [
  /^\.env(?:\..+)?$/u,
  /^\.npmrc$/u,
  /^\.pypirc$/u,
  /^\.netrc$/u,
  /^credentials(?:\.[^.]+)?\.json$/u,
  /^service-account(?:\.[^.]+)?\.json$/u,
  /\.(?:jks|key|keystore|p12|pem|pfx)$/u,
];

function fail(code) {
  throw new Error(code);
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

function parseArguments(argv) {
  let allowlistPath;
  let reportPath;
  const artifacts = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value) fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
    if (flag === '--allowlist') {
      if (allowlistPath) fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
      allowlistPath = resolve(value);
    } else if (flag === '--report') {
      if (reportPath) fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
      reportPath = resolve(value);
    } else if (flag === '--artifact') {
      const separatorIndex = value.indexOf('=');
      if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
      }
      const name = value.slice(0, separatorIndex);
      const path = resolve(value.slice(separatorIndex + 1));
      if (!expectedArtifacts.includes(name) || artifacts.has(name)) {
        fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
      }
      artifacts.set(name, path);
    } else {
      fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
    }
  }
  if (
    !allowlistPath ||
    !reportPath ||
    artifacts.size !== expectedArtifacts.length ||
    expectedArtifacts.some((name) => !artifacts.has(name)) ||
    new Set(artifacts.values()).size !== artifacts.size
  ) {
    fail('ARTIFACT_SCAN_ARGUMENTS_INVALID');
  }
  return { allowlistPath, reportPath, artifacts };
}

function readAllowlist(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail('ARTIFACT_SCAN_ALLOWLIST_INVALID');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
    fail('ARTIFACT_SCAN_ALLOWLIST_INVALID');
  }
  let parsed;
  try {
    parsed = JSON.parse(safeReadFile(path, metadata).toString('utf8'));
  } catch {
    fail('ARTIFACT_SCAN_ALLOWLIST_INVALID');
  }
  if (
    !exactKeys(parsed, ['entries', 'schemaVersion']) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    fail('ARTIFACT_SCAN_ALLOWLIST_INVALID');
  }
  const entries = new Map();
  const now = Date.now();
  const maximumExpiry = now + 90 * 24 * 60 * 60 * 1000;
  for (const entry of parsed.entries) {
    if (
      !exactKeys(entry, ['expiresAt', 'fingerprint', 'reason']) ||
      typeof entry.fingerprint !== 'string' ||
      !fingerprintPattern.test(entry.fingerprint) ||
      entries.has(entry.fingerprint) ||
      typeof entry.reason !== 'string' ||
      entry.reason.length < 10 ||
      entry.reason.length > 240 ||
      /[\u0000-\u001f\u007f]/u.test(entry.reason) ||
      typeof entry.expiresAt !== 'string'
    ) {
      fail('ARTIFACT_SCAN_ALLOWLIST_INVALID');
    }
    const expiration = Date.parse(entry.expiresAt);
    if (
      !Number.isFinite(expiration) ||
      new Date(expiration).toISOString() !== entry.expiresAt ||
      expiration > maximumExpiry
    ) {
      fail('ARTIFACT_SCAN_ALLOWLIST_INVALID');
    }
    if (expiration <= now) fail('ARTIFACT_SCAN_ALLOWLIST_EXPIRED');
    entries.set(entry.fingerprint, entry);
  }
  return entries;
}

function verifyReportDestination(path) {
  if (existsSync(path)) fail('ARTIFACT_SCAN_REPORT_UNSAFE');
  let metadata;
  try {
    metadata = lstatSync(dirname(path));
  } catch {
    fail('ARTIFACT_SCAN_REPORT_UNSAFE');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('ARTIFACT_SCAN_REPORT_UNSAFE');
  }
}

function inside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function artifactRoots(artifacts) {
  const roots = new Map();
  for (const name of expectedArtifacts) {
    const path = artifacts.get(name);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      fail('ARTIFACT_SCAN_INPUT_INVALID');
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(
        metadata.isSymbolicLink() ? 'ARTIFACT_SCAN_INPUT_UNSAFE' : 'ARTIFACT_SCAN_INPUT_INVALID',
      );
    }
    let real;
    try {
      real = realpathSync(path);
    } catch {
      fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    }
    roots.set(name, real);
  }
  const values = [...roots.values()];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (
        values[left] === values[right] ||
        inside(values[left], values[right]) ||
        inside(values[right], values[left])
      ) {
        fail('ARTIFACT_SCAN_INPUT_UNSAFE');
      }
    }
  }
  return roots;
}

function safeReadFile(path, metadata) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== metadata.dev ||
      before.ino !== metadata.ino ||
      before.size !== metadata.size ||
      before.size > maximumFileBytes
    ) {
      fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      contents.length !== before.size
    ) {
      fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    }
    return contents;
  } catch (error) {
    if (error instanceof Error && error.message === 'ARTIFACT_SCAN_INPUT_UNSAFE') throw error;
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fingerprint(artifact, path, pattern, matchedBytes) {
  const matchHash = createHash('sha256').update(matchedBytes).digest('hex');
  return createHash('sha256')
    .update(artifact)
    .update('\u0000')
    .update(path)
    .update('\u0000')
    .update(pattern)
    .update('\u0000')
    .update(matchHash)
    .digest('hex');
}

function addFinding(findings, artifact, path, pattern, matchedBytes) {
  const key = fingerprint(artifact, path, pattern, matchedBytes);
  findings.set(key, { fingerprint: key, artifact, path, pattern });
}

function isPrivateFile(path) {
  const name = basename(path).toLowerCase();
  return privateFilePatterns.some((pattern) => pattern.test(name));
}

function scanFile(artifact, root, path, metadata, findings) {
  const relativePath = relative(root, path).split(sep).join('/');
  if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) {
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  }
  const contents = safeReadFile(path, metadata);
  const contentHash = createHash('sha256').update(contents).digest();
  if (isPrivateFile(relativePath)) {
    addFinding(findings, artifact, relativePath, 'private_config_file', contentHash);
    if ((metadata.mode & 0o044) !== 0) {
      addFinding(
        findings,
        artifact,
        relativePath,
        'world_readable_secret_file',
        Buffer.from(String(metadata.mode & 0o777), 'utf8'),
      );
    }
  }
  const text = contents.toString('utf8');
  for (const { id, expression } of contentPatterns) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      addFinding(findings, artifact, relativePath, id, Buffer.from(match[0], 'utf8'));
    }
  }
  return contents.length;
}

function scanDirectory(artifact, root, directory, findings, summary) {
  let before;
  try {
    before = lstatSync(directory);
  } catch {
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  }
  if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory) {
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  }
  let names;
  try {
    names = readdirSync(directory).toSorted();
  } catch {
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  }
  for (const name of names) {
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\u0000')) {
      fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    }
    const path = resolve(directory, name);
    if (!inside(root, path)) fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    }
    if (metadata.isSymbolicLink()) fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    if (metadata.isDirectory()) {
      scanDirectory(artifact, root, path, findings, summary);
    } else if (metadata.isFile()) {
      summary.files += 1;
      summary.bytes += scanFile(artifact, root, path, metadata, findings);
    } else {
      fail('ARTIFACT_SCAN_INPUT_UNSAFE');
    }
  }
  let after;
  try {
    after = lstatSync(directory);
  } catch {
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  }
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    fail('ARTIFACT_SCAN_INPUT_UNSAFE');
  }
}

function scan(roots) {
  const findings = new Map();
  const artifacts = [];
  for (const name of expectedArtifacts) {
    const summary = { name, files: 0, bytes: 0 };
    const root = roots.get(name);
    scanDirectory(name, root, root, findings, summary);
    if (summary.files === 0) fail('ARTIFACT_SCAN_INPUT_INVALID');
    artifacts.push(summary);
  }
  return { artifacts, findings };
}

function writeReport(path, report) {
  try {
    writeFileSync(path, `${JSON.stringify(report)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    fail('ARTIFACT_SCAN_REPORT_UNSAFE');
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  verifyReportDestination(options.reportPath);
  const allowlist = readAllowlist(options.allowlistPath);
  const roots = artifactRoots(options.artifacts);
  const { artifacts, findings: discovered } = scan(roots);
  for (const key of allowlist.keys()) {
    if (!discovered.has(key)) fail('ARTIFACT_SCAN_ALLOWLIST_STALE');
  }
  let allowlistedCount = 0;
  const findings = [];
  for (const [key, finding] of [...discovered.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (allowlist.has(key)) allowlistedCount += 1;
    else findings.push(finding);
  }
  findings.sort(
    (left, right) =>
      left.artifact.localeCompare(right.artifact) ||
      left.path.localeCompare(right.path) ||
      left.pattern.localeCompare(right.pattern) ||
      left.fingerprint.localeCompare(right.fingerprint),
  );
  writeReport(options.reportPath, {
    schemaVersion: 1,
    status: findings.length === 0 ? 'success' : 'failure',
    artifacts,
    allowlistedCount,
    findings,
  });
  if (findings.length > 0) {
    process.stderr.write(`ARTIFACT_SCAN_FINDINGS count=${findings.length}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `ARTIFACT_SCAN_OK artifacts=${artifacts.length} findings=0 allowlisted=${allowlistedCount}\n`,
    );
  }
} catch (error) {
  const code =
    error instanceof Error && /^ARTIFACT_SCAN_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'ARTIFACT_SCAN_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
