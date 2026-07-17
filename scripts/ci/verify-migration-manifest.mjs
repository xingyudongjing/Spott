#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const MIGRATION_FILENAME = /^(?<prefix>[0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;

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
    if (!flag?.startsWith('--') || value === undefined || values.has(flag)) {
      fail('USAGE', 'arguments must be unique --name value pairs');
    }
    values.set(flag, value);
  }
  for (const required of ['--manifest', '--schema', '--migrations-dir']) {
    if (!values.has(required)) fail('USAGE', `missing ${required}`);
  }
  const allowed = new Set([
    '--manifest',
    '--schema',
    '--migrations-dir',
    '--base-manifest',
    '--base-ref',
    '--repo-root',
  ]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) fail('USAGE', `unknown argument ${flag}`);
  }
  if (values.has('--base-manifest') && values.has('--base-ref')) {
    fail('USAGE', '--base-manifest and --base-ref are mutually exclusive');
  }
  if (values.has('--base-ref') && !values.has('--repo-root')) {
    fail('USAGE', '--base-ref requires --repo-root');
  }
  return {
    manifestPath: resolve(values.get('--manifest')),
    schemaPath: resolve(values.get('--schema')),
    migrationsDirectory: resolve(values.get('--migrations-dir')),
    baseManifestPath: values.has('--base-manifest')
      ? resolve(values.get('--base-manifest'))
      : undefined,
    baseRef: values.get('--base-ref'),
    repositoryRoot: values.has('--repo-root')
      ? realpathSync(resolve(values.get('--repo-root')))
      : undefined,
  };
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('MANIFEST_INVALID', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('MANIFEST_INVALID', `${label} keys differ from the reviewed schema`);
  }
}

function readJson(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail('MANIFEST_INVALID', `${label} is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('MANIFEST_INVALID', `${label} must be a regular non-symlink file`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('MANIFEST_INVALID', `${label} must be strict JSON`);
  }
}

function validateSchema(path) {
  const schema = readJson(path, 'schema');
  if (
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema.$id !== 'https://spott.invalid/schemas/migration-manifest.schema.json' ||
    schema.additionalProperties !== false
  ) {
    fail('MANIFEST_INVALID', 'schema identity or fail-closed policy is invalid');
  }
}

function validateManifest(value, label) {
  exactKeys(value, ['$schema', 'schemaVersion', 'migrations'], label);
  if (value.$schema !== './migration-manifest.schema.json' || value.schemaVersion !== 1) {
    fail('MANIFEST_INVALID', `${label} schema version is unsupported`);
  }
  if (!Array.isArray(value.migrations) || value.migrations.length === 0) {
    fail('MANIFEST_INVALID', `${label}.migrations must be a non-empty array`);
  }

  const sequences = new Set();
  const filenames = new Set();
  for (const [index, row] of value.migrations.entries()) {
    exactKeys(row, ['sequence', 'filename', 'sha256'], `${label}.migrations[${index}]`);
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence > 9999) {
      fail('MANIFEST_INVALID', `${label}.migrations[${index}].sequence is invalid`);
    }
    if (sequences.has(row.sequence) || filenames.has(row.filename)) {
      fail('MANIFEST_INVALID', `${label} contains a duplicate sequence or filename`);
    }
    sequences.add(row.sequence);
    filenames.add(row.filename);

    if (typeof row.filename !== 'string') {
      fail('MANIFEST_INVALID', `${label}.migrations[${index}].filename is invalid`);
    }
    const match = MIGRATION_FILENAME.exec(row.filename);
    if (!match || Number(match.groups.prefix) !== row.sequence) {
      fail('MANIFEST_INVALID', `${label}.migrations[${index}] filename does not match sequence`);
    }
    if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) {
      fail('MANIFEST_INVALID', `${label}.migrations[${index}].sha256 is invalid`);
    }
    const expectedSequence = index + 1;
    if (row.sequence !== expectedSequence) {
      fail('SEQUENCE_NOT_CONTIGUOUS', `${label} expected sequence ${expectedSequence}`);
    }
  }
  return value.migrations;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyMigrationFiles(rows, directory) {
  let directoryMetadata;
  try {
    directoryMetadata = lstatSync(directory);
  } catch {
    fail('MIGRATION_SET_MISMATCH', 'migrations directory is missing');
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail('MIGRATION_FILE_UNSAFE', 'migrations directory must be a regular directory');
  }

  const actual = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  const expected = rows.map((row) => row.filename).toSorted();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail('MIGRATION_SET_MISMATCH', 'SQL migration files differ from the immutable manifest');
  }

  for (const row of rows) {
    const path = resolve(directory, row.filename);
    const pathWithinDirectory = relative(directory, path);
    if (
      isAbsolute(pathWithinDirectory) ||
      pathWithinDirectory === '..' ||
      pathWithinDirectory.startsWith(`..${sep}`)
    ) {
      fail('MIGRATION_FILE_UNSAFE', 'migration path escapes the owned directory');
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail('MIGRATION_FILE_UNSAFE', `${row.filename} must be a regular non-symlink file`);
    }
    if (sha256(path) !== row.sha256) {
      fail('MIGRATION_HASH_MISMATCH', `${row.filename} differs from its immutable checksum`);
    }
  }
}

function readBaseFromGit({ baseRef, repositoryRoot, manifestPath }) {
  if (!COMMIT_SHA.test(baseRef))
    fail('BASE_REF_INVALID', 'base ref must be a full lowercase commit SHA');
  const canonicalManifest = realpathSync(manifestPath);
  const relativeManifest = relative(repositoryRoot, canonicalManifest);
  if (
    isAbsolute(relativeManifest) ||
    relativeManifest === '..' ||
    relativeManifest.startsWith(`..${sep}`)
  ) {
    fail('BASE_REF_INVALID', 'manifest must be inside repository root');
  }
  const result = spawnSync('git', ['show', `${baseRef}:${relativeManifest}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) fail('BASE_MANIFEST_UNAVAILABLE', 'base manifest is unavailable');
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('BASE_MANIFEST_UNAVAILABLE', 'base manifest is not strict JSON');
  }
}

function compareBase(baseRows, currentRows) {
  if (currentRows.length < baseRows.length) {
    fail('BASE_MIGRATION_DELETED', 'an existing base migration row was deleted');
  }
  for (const [index, base] of baseRows.entries()) {
    const current = currentRows[index];
    if (
      current.sequence !== base.sequence ||
      current.filename !== base.filename ||
      current.sha256 !== base.sha256
    ) {
      fail('BASE_MIGRATION_CHANGED', `base migration ${base.filename} was edited or renamed`);
    }
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  validateSchema(options.schemaPath);
  const current = readJson(options.manifestPath, 'manifest');
  const currentRows = validateManifest(current, 'manifest');

  let base;
  if (options.baseManifestPath) base = readJson(options.baseManifestPath, 'base manifest');
  if (options.baseRef) base = readBaseFromGit(options);
  if (base) {
    const baseRows = validateManifest(base, 'base manifest');
    compareBase(baseRows, currentRows);
  }

  verifyMigrationFiles(currentRows, options.migrationsDirectory);
  process.stdout.write(`MIGRATION_MANIFEST_OK count=${currentRows.length}\n`);
} catch (error) {
  if (error instanceof VerificationError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write('VERIFIER_INTERNAL_ERROR: migration manifest verification failed\n');
    process.exitCode = 1;
  }
}
