import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const migrationPath = resolve(repositoryRoot, 'database/migrations/0020_sync_correctness.sql');

function migrationSource(): string {
  return existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
}

describe('sync correctness migration', () => {
  it('scopes pending-operation identity and device ownership to the authenticated user', () => {
    const migration = migrationSource();

    expect(migration).toMatch(
      /PRIMARY KEY\s*\(\s*user_id\s*,\s*device_id\s*,\s*operation_id\s*\)/i,
    );
    expect(migration).toMatch(
      /FOREIGN KEY\s*\(\s*device_id\s*,\s*user_id\s*\)\s*REFERENCES identity\.devices\s*\(\s*id\s*,\s*user_id\s*\)/i,
    );
  });

  it('serializes per-entity change writes and rejects version regression at the database boundary', () => {
    const migration = migrationSource();

    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toMatch(/NEW\.version\s*<\s*latest_version/i);
    expect(migration).toMatch(/BEFORE INSERT ON sync\.change_log/i);
  });
});
