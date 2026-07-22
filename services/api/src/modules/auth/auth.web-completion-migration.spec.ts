import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');
const migrationPath = resolve(
  root,
  'database/migrations/0030_web_session_completion_outcomes.sql',
);
const manifestPath = resolve(root, 'database/migration-manifest.json');

type MigrationManifest = {
  migrations: Array<{
    sequence: number;
    filename: string;
    sha256: string;
  }>;
};

function migrationSQL(): string {
  expect(existsSync(migrationPath)).toBe(true);
  return readFileSync(migrationPath, 'utf8');
}

describe('0030 Web session completion outcomes migration', () => {
  it('creates only a completed, secret-free recovery outcome', () => {
    const sql = migrationSQL();
    const table = sql.match(
      /CREATE TABLE identity\.web_session_completion_outcomes \(([\s\S]*?)\n\);/u,
    );

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(table?.[1]).toBeDefined();

    const definition = table?.[1] ?? '';
    const compactDefinition = definition.replace(/\s+/gu, ' ');
    expect(compactDefinition).toMatch(
      /challenge_id uuid PRIMARY KEY REFERENCES identity\.email_challenges\(id\) ON DELETE RESTRICT/u,
    );
    expect(compactDefinition).toMatch(
      /attempt_hash bytea NOT NULL UNIQUE\s+CHECK \(octet_length\(attempt_hash\) = 32\)/u,
    );
    expect(compactDefinition).toMatch(
      /request_digest bytea NOT NULL\s+CHECK \(octet_length\(request_digest\) = 32\)/u,
    );
    expect(compactDefinition).toMatch(/user_id uuid NOT NULL REFERENCES identity\.users\(id\)/u);
    expect(compactDefinition).toMatch(/device_id uuid NOT NULL REFERENCES identity\.devices\(id\)/u);
    expect(compactDefinition).toMatch(
      /session_id uuid NOT NULL UNIQUE\s+REFERENCES identity\.sessions\(id\) ON DELETE CASCADE/u,
    );
    expect(compactDefinition).toMatch(/family_id uuid NOT NULL/u);
    expect(compactDefinition).toMatch(
      /binding_id uuid NOT NULL UNIQUE\s+REFERENCES identity\.device_bindings\(id\) ON DELETE CASCADE/u,
    );
    expect(compactDefinition).toMatch(
      /refresh_generation bigint NOT NULL\s+CHECK \(refresh_generation = 0\)/u,
    );
    expect(compactDefinition).toMatch(
      /binding_generation bigint NOT NULL\s+CHECK \(binding_generation = 0\)/u,
    );
    expect(compactDefinition).toMatch(
      /derivation_version text NOT NULL\s+CHECK \(derivation_version = 'v1'\)/u,
    );
    expect(compactDefinition).toContain(
      "CHECK (derivation_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')",
    );
    expect(compactDefinition).toMatch(
      /created_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/u,
    );
    expect(compactDefinition).toContain('recovery_expires_at > created_at');
    expect(compactDefinition).toContain(
      "recovery_expires_at <= created_at + interval '15 minutes'",
    );

    expect(definition).not.toMatch(
      /^\s*(?:[a-z0-9_]*(?:secret|token|proof|code|body|json)[a-z0-9_]*)\s+[a-z]/imu,
    );
    expect(definition).not.toMatch(/^\s*(?:state|status)\s+[a-z]/imu);
  });

  it('indexes recovery expiry and rejects every outcome update', () => {
    const sql = migrationSQL();

    expect(sql).toMatch(
      /CREATE INDEX ix_web_session_completion_outcomes_recovery_expiry\s+ON identity\.web_session_completion_outcomes\(recovery_expires_at\);/u,
    );
    expect(sql).toMatch(
      /CREATE INDEX ix_email_challenges_cleanup_verified\s+ON identity\.email_challenges\(verified_at, id\)\s+WHERE verified_at IS NOT NULL;/u,
    );
    expect(sql).toMatch(
      /CREATE INDEX ix_email_challenges_cleanup_expired_unverified\s+ON identity\.email_challenges\(expires_at, id\)\s+WHERE verified_at IS NULL;/u,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION identity\.reject_web_session_completion_outcome_update\(\)[\s\S]*?RAISE EXCEPTION 'web session completion outcomes are immutable'/u,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER trg_web_session_completion_outcome_immutable\s+BEFORE UPDATE ON identity\.web_session_completion_outcomes/u,
    );
    expect(sql).not.toMatch(
      /BEFORE UPDATE OR DELETE ON identity\.web_session_completion_outcomes/u,
    );
  });

  it('keeps sequence 30 after the first 29 migrations and pins its checksum', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest;
    const existing = manifest.migrations.slice(0, 29);
    const appended = manifest.migrations[29];

    expect(existing).toHaveLength(29);
    expect(existing.at(-1)?.sequence).toBe(29);
    expect(existing.at(-1)?.filename).toBe('0029_event_contact_channels.sql');
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(30);
    expect(appended).toEqual({
      sequence: 30,
      filename: '0030_web_session_completion_outcomes.sql',
      sha256: createHash('sha256').update(readFileSync(migrationPath)).digest('hex'),
    });
  });
});
