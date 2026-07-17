import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const filenamePattern = /^(?<prefix>[0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface MigrationManifestRow {
  sequence: number;
  filename: string;
  sha256: string;
}

export interface AppliedMigration {
  version: string;
  checksum: string;
}

export interface LoadMigrationManifestInput {
  manifestPath: string;
  migrationsDirectory: string;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MIGRATION_MANIFEST_INVALID: ${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`MIGRATION_MANIFEST_INVALID: ${label} keys differ from the contract`);
  }
}

function parseRows(value: unknown): MigrationManifestRow[] {
  exactKeys(value, ['$schema', 'schemaVersion', 'migrations'], 'manifest');
  if (value.$schema !== './migration-manifest.schema.json' || value.schemaVersion !== 1) {
    throw new Error('MIGRATION_MANIFEST_INVALID: unsupported schema version');
  }
  if (!Array.isArray(value.migrations) || value.migrations.length === 0) {
    throw new Error('MIGRATION_MANIFEST_INVALID: migrations must be non-empty');
  }

  return value.migrations.map((candidate, index) => {
    exactKeys(candidate, ['sequence', 'filename', 'sha256'], `migrations[${index}]`);
    const sequence = candidate.sequence;
    const filename = candidate.filename;
    const checksum = candidate.sha256;
    if (!Number.isSafeInteger(sequence) || sequence !== index + 1 || sequence > 9999) {
      throw new Error('MIGRATION_MANIFEST_INVALID: sequence is not contiguous');
    }
    if (typeof filename !== 'string') {
      throw new Error('MIGRATION_MANIFEST_INVALID: filename must be a string');
    }
    const match = filenamePattern.exec(filename);
    if (!match || Number(match.groups?.prefix) !== sequence) {
      throw new Error('MIGRATION_MANIFEST_INVALID: filename does not match sequence');
    }
    if (typeof checksum !== 'string' || !sha256Pattern.test(checksum)) {
      throw new Error('MIGRATION_MANIFEST_INVALID: checksum must be SHA-256');
    }
    return { sequence, filename, sha256: checksum };
  });
}

function hash(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

export async function loadMigrationManifest({
  manifestPath,
  migrationsDirectory,
}: LoadMigrationManifestInput): Promise<MigrationManifestRow[]> {
  let parsed: unknown;
  try {
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('manifest must be a regular file');
    }
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable manifest';
    throw new Error(`MIGRATION_MANIFEST_INVALID: ${reason}`);
  }
  const rows = parseRows(parsed);
  const actualFilenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .toSorted();
  const expectedFilenames = rows.map((row) => row.filename).toSorted();
  if (
    actualFilenames.length !== expectedFilenames.length ||
    actualFilenames.some((filename, index) => filename !== expectedFilenames[index])
  ) {
    throw new Error('MIGRATION_MANIFEST_SET_MISMATCH: SQL files differ from manifest');
  }

  for (const row of rows) {
    const path = join(migrationsDirectory, row.filename);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`MIGRATION_MANIFEST_FILE_UNSAFE: ${row.filename}`);
    }
    if (hash(await readFile(path)) !== row.sha256) {
      throw new Error(`MIGRATION_MANIFEST_HASH_MISMATCH: ${row.filename}`);
    }
  }
  return rows;
}

export function assertAppliedMigrationsMatchManifest(
  applied: readonly AppliedMigration[],
  manifest: readonly MigrationManifestRow[],
): void {
  if (applied.length !== manifest.length) {
    throw new Error('MIGRATION_DATABASE_SET_MISMATCH: applied row count differs from manifest');
  }
  assertAppliedMigrationPrefixMatchesManifest(applied, manifest);
}

export function assertAppliedMigrationPrefixMatchesManifest(
  applied: readonly AppliedMigration[],
  manifest: readonly MigrationManifestRow[],
): void {
  if (applied.length > manifest.length) {
    throw new Error('MIGRATION_DATABASE_SET_MISMATCH: applied row count exceeds manifest');
  }
  for (const [index, actual] of applied.entries()) {
    const expected = manifest[index];
    if (!expected || actual.version !== expected.filename) {
      throw new Error('MIGRATION_DATABASE_SET_MISMATCH: applied versions differ from manifest');
    }
    if (actual.checksum !== expected.sha256) {
      throw new Error(`MIGRATION_DATABASE_CHECKSUM_MISMATCH: ${expected.filename}`);
    }
  }
}
