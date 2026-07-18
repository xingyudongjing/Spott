import { createHash } from 'node:crypto';

import type { MigrationManifestRow } from './migration-manifest.js';

export interface MigrationTransactionClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const insertLedgerSQL = 'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)';
const legacyUnwrappedMigrations = new Map<string, string>([
  [
    '0026_event_promotion.sql',
    'a2196808c41b380cc243fa19497f84fcc82b7ab18951cbe2e032e284787e7d58',
  ],
]);

function isCommentOrWhitespace(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('--');
}

export function unwrapMigrationTransaction(sql: string): string {
  const lines = sql.split('\n');
  const firstStatement = lines.findIndex((line) => !isCommentOrWhitespace(line));
  let lastStatement = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isCommentOrWhitespace(lines[index] ?? '')) {
      lastStatement = index;
      break;
    }
  }
  const transactionControl = lines
    .map((line, index) => ({ statement: line.trim(), index }))
    .filter(({ statement }) => statement === 'BEGIN;' || statement === 'COMMIT;');
  if (
    firstStatement < 0 ||
    lastStatement < 0 ||
    lines[firstStatement]?.trim() !== 'BEGIN;' ||
    lines[lastStatement]?.trim() !== 'COMMIT;' ||
    transactionControl.length !== 2 ||
    transactionControl[0]?.index !== firstStatement ||
    transactionControl[1]?.index !== lastStatement ||
    firstStatement >= lastStatement
  ) {
    throw new Error('MIGRATION_TRANSACTION_ENVELOPE_INVALID');
  }

  const unwrapped = lines
    .filter((_line, index) => index !== firstStatement && index !== lastStatement)
    .join('\n');
  if (unwrapped.split('\n').every(isCommentOrWhitespace)) {
    throw new Error('MIGRATION_TRANSACTION_ENVELOPE_INVALID');
  }
  return unwrapped;
}

export function unwrapManifestMigrationTransaction(
  migration: MigrationManifestRow,
  sql: string,
): string {
  try {
    return unwrapMigrationTransaction(sql);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'MIGRATION_TRANSACTION_ENVELOPE_INVALID') {
      throw error;
    }
  }

  const legacyChecksum = legacyUnwrappedMigrations.get(migration.filename);
  const actualChecksum = createHash('sha256').update(sql, 'utf8').digest('hex');
  if (
    !legacyChecksum
    || migration.sha256 !== legacyChecksum
    || actualChecksum !== legacyChecksum
  ) {
    throw new Error('MIGRATION_TRANSACTION_ENVELOPE_INVALID');
  }
  return sql;
}

export async function applyManifestMigration(
  client: MigrationTransactionClient,
  migration: MigrationManifestRow,
  wrappedSQL: string,
): Promise<void> {
  const migrationBody = unwrapManifestMigrationTransaction(migration, wrappedSQL);
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query(migrationBody);
    await client.query(insertLedgerSQL, [migration.filename, migration.sha256]);
    await client.query('COMMIT');
    began = false;
  } catch (error) {
    if (!began) throw error;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'MIGRATION_TRANSACTION_ROLLBACK_FAILED');
    }
    throw error;
  }
}
