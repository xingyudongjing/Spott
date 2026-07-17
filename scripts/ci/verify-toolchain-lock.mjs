#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const EXACT_VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DIGEST_REFERENCE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const HTTPS_URL = /^https:\/\/[^\s]+$/u;
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.turbo',
  '.worktrees',
  'DerivedData',
  'artifacts',
  'dist',
  'node_modules',
  'output',
]);

class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new VerificationError(code, message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail('USAGE', 'expected --lock, --schema, and --repo-root value pairs');
    }
    values.set(flag.slice(2), value);
  }
  for (const name of ['lock', 'schema', 'repo-root']) {
    if (!values.has(name)) fail('USAGE', `missing --${name}`);
  }
  return {
    lockPath: resolve(values.get('lock')),
    schemaPath: resolve(values.get('schema')),
    repositoryRoot: realpathSync(resolve(values.get('repo-root'))),
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('SCHEMA_INVALID', `${label} is not readable strict JSON: ${error?.code ?? 'parse_error'}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEMA_INVALID', `${label} must be an object`);
  }
}

function requireExactKeys(value, label, requiredKeys) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...requiredKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('SCHEMA_INVALID', `${label} keys do not match the reviewed schema`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('SCHEMA_INVALID', `${label} must be a non-empty string`);
  }
}

function requireExactVersion(value, label) {
  requireString(value, label);
  if (!EXACT_VERSION.test(value)) {
    fail('EXACT_VERSION_REQUIRED', `${label} must be an exact version`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('SCHEMA_INVALID', `${label} must be a lowercase SHA-256`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('SCHEMA_INVALID', `${label} must be a positive safe integer`);
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function resolveOwnedPath(root, untrustedPath) {
  requireString(untrustedPath, 'localFiles.path');
  if (isAbsolute(untrustedPath) || untrustedPath.includes('\0')) {
    fail('SCHEMA_INVALID', 'local file path must be repository-relative');
  }
  const candidate = resolve(root, untrustedPath);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail('SCHEMA_INVALID', 'local file path escapes repository root');
  }
  return candidate;
}

function validateLocalFiles(entries, root) {
  if (!Array.isArray(entries) || entries.length < 2) {
    fail('SCHEMA_INVALID', 'localFiles must contain at least two reviewed files');
  }
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    requireExactKeys(entry, `localFiles[${index}]`, ['path', 'sha256']);
    requireSha256(entry.sha256, `localFiles[${index}].sha256`);
    if (seen.has(entry.path)) fail('SCHEMA_INVALID', 'local file paths must be unique');
    seen.add(entry.path);
    const path = resolveOwnedPath(root, entry.path);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      fail('LOCAL_FILE_MISSING', `reviewed local file is absent: ${entry.path}`);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail('LOCAL_FILE_MISSING', `reviewed local file is not a regular file: ${entry.path}`);
    }
    if (sha256File(path) !== entry.sha256) {
      fail('LOCAL_FILE_HASH_MISMATCH', `reviewed local file changed: ${entry.path}`);
    }
  }
}

function validateOrigin(origin, label) {
  requireExactKeys(origin, label, ['url', 'license']);
  if (typeof origin.url !== 'string' || !HTTPS_URL.test(origin.url)) {
    fail('SCHEMA_INVALID', `${label}.url must be HTTPS`);
  }
  requireString(origin.license, `${label}.license`);
}

function validateBinary(binary, label) {
  requireExactKeys(binary, label, ['path', 'revision', 'bytes', 'sha256']);
  if (typeof binary.path !== 'string' || !binary.path.startsWith('/')) {
    fail('SCHEMA_INVALID', `${label}.path must be absolute inside the container`);
  }
  requireString(binary.revision, `${label}.revision`);
  requirePositiveInteger(binary.bytes, `${label}.bytes`);
  requireSha256(binary.sha256, `${label}.sha256`);
}

function validateContainer(container, label, playwright = false) {
  const keys = ['version', 'tag', 'reference', 'platform', 'origin'];
  if (playwright) keys.push('packageVersion', 'chromium', 'ffmpeg');
  requireExactKeys(container, label, keys);
  requireString(container.version, `${label}.version`);
  requireString(container.tag, `${label}.tag`);
  if (typeof container.reference !== 'string' || !DIGEST_REFERENCE.test(container.reference)) {
    fail('IMMUTABLE_DIGEST_REQUIRED', `${label}.reference must end in a full manifest digest`);
  }
  if (!new Set(['linux/amd64', 'linux/arm64']).has(container.platform)) {
    fail('SCHEMA_INVALID', `${label}.platform is unsupported`);
  }
  validateOrigin(container.origin, `${label}.origin`);
  if (playwright) {
    if (container.packageVersion !== '1.61.1') {
      fail('SCHEMA_INVALID', 'Playwright package and image version must be exactly 1.61.1');
    }
    validateBinary(container.chromium, `${label}.chromium`);
    validateBinary(container.ffmpeg, `${label}.ffmpeg`);
  }
}

function validateDownload(download, label, signed = false) {
  const keys = ['version', 'url', 'bytes', 'sha256', 'archiveFormat', 'origin'];
  if (signed) keys.push('signature', 'expectedPostgresVersion', 'expectedPostgisFullVersion');
  requireExactKeys(download, label, keys);
  requireString(download.version, `${label}.version`);
  if (typeof download.url !== 'string' || !HTTPS_URL.test(download.url)) {
    fail('SCHEMA_INVALID', `${label}.url must be HTTPS`);
  }
  requirePositiveInteger(download.bytes, `${label}.bytes`);
  requireSha256(download.sha256, `${label}.sha256`);
  if (!new Set(['tar.gz', 'tar.bz2', 'tar.xz', 'zip', 'pkg', 'dmg']).has(download.archiveFormat)) {
    fail('SCHEMA_INVALID', `${label}.archiveFormat is unsupported`);
  }
  validateOrigin(download.origin, `${label}.origin`);
  if (signed) {
    requireExactKeys(download.signature, `${label}.signature`, [
      'policy',
      'path',
      'authority',
      'teamIdentifier',
    ]);
    if (!new Set(['required', 'not_signed_upstream']).has(download.signature.policy)) {
      fail('SCHEMA_INVALID', `${label}.signature.policy is unsupported`);
    }
    requireString(download.signature.path, `${label}.signature.path`);
    requireString(download.signature.authority, `${label}.signature.authority`);
    requireString(download.signature.teamIdentifier, `${label}.signature.teamIdentifier`);
    requireString(download.expectedPostgresVersion, `${label}.expectedPostgresVersion`);
    requireExactKeys(download.expectedPostgisFullVersion, `${label}.expectedPostgisFullVersion`, [
      'postgisRevision',
      'pgsql',
      'geos',
      'proj',
      'networkEnabled',
      'libxml',
      'libjson',
      'libprotobuf',
      'wagyu',
    ]);
    for (const name of [
      'postgisRevision',
      'pgsql',
      'geos',
      'proj',
      'networkEnabled',
      'libxml',
      'libjson',
      'libprotobuf',
      'wagyu',
    ]) {
      requireString(
        download.expectedPostgisFullVersion[name],
        `${label}.expectedPostgisFullVersion.${name}`,
      );
    }
    if (!new Set(['ON', 'OFF']).has(download.expectedPostgisFullVersion.networkEnabled)) {
      fail('SCHEMA_INVALID', `${label}.expectedPostgisFullVersion.networkEnabled is invalid`);
    }
  }
}

function hasJavaFamilyInput(root, java) {
  const extensions = new Set(java.sentinelExtensions);
  const buildFiles = new Set(java.sentinelBuildFiles);
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (
        entry.isFile() &&
        (extensions.has(extname(entry.name)) || buildFiles.has(entry.name))
      ) {
        return true;
      }
    }
  }
  return false;
}

function validateLock(lock, schema, root) {
  requireObject(schema, 'schema');
  if (schema.$id !== 'https://spott.invalid/schemas/toolchain-lock.schema.json') {
    fail('SCHEMA_INVALID', 'unexpected schema identity');
  }
  requireExactKeys(lock, 'lock', [
    '$schema',
    'schemaVersion',
    'node',
    'pnpm',
    'xcode',
    'iosSimulatorRuntime',
    'java',
    'localFiles',
    'containers',
    'downloads',
  ]);
  if (lock.$schema !== './toolchain-lock.schema.json' || lock.schemaVersion !== 1) {
    fail('SCHEMA_INVALID', 'unsupported lock schema version');
  }

  for (const name of ['node', 'pnpm']) {
    requireExactKeys(lock[name], name, ['version']);
    requireExactVersion(lock[name].version, `${name}.version`);
  }
  if (lock.node.version !== process.versions.node) {
    fail('RUNTIME_VERSION_MISMATCH', 'validator must run under the locked Node runtime');
  }

  requireExactKeys(lock.xcode, 'xcode', ['version', 'build', 'path']);
  requireExactVersion(lock.xcode.version, 'xcode.version');
  requireString(lock.xcode.build, 'xcode.build');
  if (lock.xcode.path !== '/Applications/Xcode.app/Contents/Developer') {
    fail('SCHEMA_INVALID', 'xcode.path is not the reviewed hosted-runner path');
  }
  requireExactKeys(lock.iosSimulatorRuntime, 'iosSimulatorRuntime', [
    'version',
    'build',
    'identifier',
  ]);
  requireExactVersion(lock.iosSimulatorRuntime.version, 'iosSimulatorRuntime.version');
  requireString(lock.iosSimulatorRuntime.build, 'iosSimulatorRuntime.build');
  if (
    !/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+$/u.test(
      lock.iosSimulatorRuntime.identifier,
    )
  ) {
    fail('SCHEMA_INVALID', 'iosSimulatorRuntime.identifier is invalid');
  }

  requireExactKeys(lock.java, 'java', ['status', 'sentinelExtensions', 'sentinelBuildFiles']);
  if (lock.java.status !== 'not_applicable') fail('SCHEMA_INVALID', 'Java status is unsupported');
  if (
    !Array.isArray(lock.java.sentinelExtensions) ||
    !Array.isArray(lock.java.sentinelBuildFiles)
  ) {
    fail('SCHEMA_INVALID', 'Java sentinels must be arrays');
  }

  validateLocalFiles(lock.localFiles, root);
  requireExactKeys(lock.containers, 'containers', [
    'playwright',
    'postgis',
    'minio',
    'minioClient',
    'redis',
    'mailpit',
    'clamav',
  ]);
  validateContainer(lock.containers.playwright, 'containers.playwright', true);
  for (const name of ['postgis', 'minio', 'minioClient', 'redis', 'mailpit', 'clamav']) {
    validateContainer(lock.containers[name], `containers.${name}`);
  }

  requireExactKeys(lock.downloads, 'downloads', [
    'k6',
    'postgresql18Client',
    'macosArm64PostgresPostgis',
  ]);
  validateDownload(lock.downloads.k6, 'downloads.k6');
  validateDownload(lock.downloads.postgresql18Client, 'downloads.postgresql18Client');
  validateDownload(
    lock.downloads.macosArm64PostgresPostgis,
    'downloads.macosArm64PostgresPostgis',
    true,
  );

  if (hasJavaFamilyInput(root, lock.java)) {
    fail('JAVA_LOCK_REQUIRED', 'Java-family input exists while Java is not_applicable');
  }
}

try {
  const { lockPath, schemaPath, repositoryRoot } = parseArguments(process.argv.slice(2));
  if (!statSync(repositoryRoot).isDirectory()) fail('USAGE', 'repo root is not a directory');
  validateLock(readJson(lockPath, 'lock'), readJson(schemaPath, 'schema'), repositoryRoot);
  process.stdout.write('TOOLCHAIN_LOCK_OK\n');
} catch (error) {
  const code = error instanceof VerificationError ? error.code : 'VERIFY_FAILED';
  const message = error instanceof Error ? error.message : 'unknown verifier failure';
  process.stderr.write(`[${code}] ${message}\n`);
  process.exitCode = 1;
}
