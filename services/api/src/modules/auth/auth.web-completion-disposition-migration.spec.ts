import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');
const migrationPath = resolve(
  root,
  'database/migrations/0031_web_session_completion_dispositions.sql',
);
const retentionMigrationPath = resolve(
  root,
  'database/migrations/0032_web_session_completion_revoke_retention.sql',
);
const manifestPath = resolve(root, 'database/migration-manifest.json');
const authServicePath = resolve(root, 'services/api/src/modules/auth/auth.service.ts');
const webCompletionPath = resolve(root, 'apps/web/app/lib/session-complete.ts');

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

describe('0031 Web session completion dispositions migration', () => {
  it('creates a secret-free attempt ledger that can represent pending, accepted, and tombstoned attempts', () => {
    const sql = migrationSQL();
    const table = sql.match(
      /CREATE TABLE identity\.web_session_completion_dispositions \(([\s\S]*?)\n\);/u,
    );

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(table?.[1]).toBeDefined();

    const definition = (table?.[1] ?? '').replace(/\s+/gu, ' ');
    expect(definition).toMatch(
      /attempt_hash bytea PRIMARY KEY CHECK \(octet_length\(attempt_hash\) = 32\)/u,
    );
    expect(definition).toMatch(/challenge_id uuid NOT NULL/u);
    expect(definition).toMatch(/device_id uuid NOT NULL/u);
    expect(definition).toMatch(/binding_id uuid NOT NULL/u);
    expect(definition).toMatch(/binding_generation bigint NOT NULL CHECK \(binding_generation = 0\)/u);
    expect(definition).toMatch(
      /authority_digest bytea NOT NULL CHECK \(octet_length\(authority_digest\) = 32\)/u,
    );
    expect(definition).toContain(
      "authority_version text NOT NULL CHECK (authority_version IN ('v1','legacy-v0'))",
    );
    expect(definition).toContain(
      "CHECK (authority_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')",
    );
    expect(definition).toContain("state text NOT NULL CHECK (state IN ('pending','accepted','discarded'))");
    expect(definition).toMatch(/session_id uuid UNIQUE/u);
    expect(definition).toMatch(/decision_expires_at timestamptz NOT NULL/u);
    expect(definition).toMatch(/retained_until timestamptz NOT NULL/u);
    expect(definition).toContain('decision_expires_at >= created_at');
    expect(definition).toContain('retained_until > decision_expires_at');
    expect(definition).not.toMatch(/REFERENCES identity\.(?:sessions|device_bindings)/u);
    expect(definition).not.toMatch(
      /^\s*(?:[a-z0-9_]*(?:secret|token|proof|code|body|json)[a-z0-9_]*)\s+[a-z]/imu,
    );
  });

  it('pins row-shape checks and a database transition guard', () => {
    const sql = migrationSQL();

    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain("state = 'accepted'");
    expect(sql).toContain("state = 'discarded'");
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION identity\.guard_web_session_completion_disposition_transition\(\)[\s\S]*?pending[\s\S]*?accepted[\s\S]*?discarded/u,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER trg_web_session_completion_disposition_transition\s+BEFORE UPDATE ON identity\.web_session_completion_dispositions/u,
    );
    expect(sql).toMatch(
      /CREATE INDEX ix_web_session_completion_dispositions_challenge\s+ON identity\.web_session_completion_dispositions\(challenge_id\)/u,
    );
  });

  it('backfills every pre-0031 completed outcome as an explicit legacy accepted disposition', () => {
    const sql = migrationSQL();

    expect(sql).toMatch(
      /INSERT INTO identity\.web_session_completion_dispositions[\s\S]*'legacy-v0'[\s\S]*'accepted'[\s\S]*FROM identity\.web_session_completion_outcomes/u,
    );
    expect(sql).toMatch(
      /outcome\.request_digest[\s\S]*outcome\.derivation_kid/u,
    );
    expect(sql).toContain('Every pre-0031 outcome is explicit after this statement');
  });

  it('appends sequence 31 without modifying the pinned 0030 migration', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest;
    const prior = manifest.migrations.slice(0, 30);
    const appended = manifest.migrations[30];

    expect(prior).toHaveLength(30);
    expect(prior.at(-1)).toEqual({
      sequence: 30,
      filename: '0030_web_session_completion_outcomes.sql',
      sha256: '04164678e453597af429ca5975f7df2e3704a6000a5761850509e6c4aa1c5627',
    });
    expect(manifest.migrations.slice(0, 31)).toHaveLength(31);
    expect(appended).toEqual({
      sequence: 31,
      filename: '0031_web_session_completion_dispositions.sql',
      sha256: createHash('sha256').update(readFileSync(migrationPath)).digest('hex'),
    });
  });
});

describe('0032 Web session completion revoke retention repair', () => {
  it('uses one transaction to extend only 30-day rows and restores the exact immutable guard', () => {
    const exists = existsSync(retentionMigrationPath);
    expect(exists).toBe(true);
    if (!exists) return;

    const repair = readFileSync(retentionMigrationPath, 'utf8');
    const original = migrationSQL();
    const guard = original.match(
      /CREATE OR REPLACE FUNCTION identity\.guard_web_session_completion_disposition_transition\(\)[\s\S]*?\$\$;/u,
    )?.[0];
    const trigger = original.match(
      /CREATE TRIGGER trg_web_session_completion_disposition_transition[\s\S]*?;/u,
    )?.[0];

    expect(repair.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(repair.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(repair.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(repair.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(repair).toContain(
      'DROP TRIGGER trg_web_session_completion_disposition_transition',
    );
    expect(repair).toMatch(
      /SET retained_until = decision_expires_at \+ interval '31 days'[\s\S]*retained_until = decision_expires_at \+ interval '30 days'/u,
    );
    expect(repair).toMatch(
      /WHERE authority_version = 'v1'[\s\S]*retained_until = decision_expires_at \+ interval '30 days'/u,
    );
    expect(guard).toBeDefined();
    expect(trigger).toBeDefined();
    expect(repair).toContain(guard ?? 'missing original guard');
    expect(repair).toContain(trigger ?? 'missing original trigger');
    expect(repair).not.toMatch(/(?:refresh_token|binding_proof|otp|code_hash)/iu);
  });

  it('appends only sequence 32 with the migration file checksum', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest;
    const exists = existsSync(retentionMigrationPath);
    expect(exists).toBe(true);
    if (!exists) return;

    expect(manifest.migrations).toHaveLength(32);
    expect(manifest.migrations.at(-1)).toEqual({
      sequence: 32,
      filename: '0032_web_session_completion_revoke_retention.sql',
      sha256: createHash('sha256').update(readFileSync(retentionMigrationPath)).digest('hex'),
    });
  });

  it('pins the Web 31-day capability to the API row and migration retention duration', () => {
    const webCompletion = readFileSync(webCompletionPath, 'utf8');
    const authService = readFileSync(authServicePath, 'utf8');

    expect(webCompletion).toContain('const reconciliationSeconds = 2_678_400;');
    expect(authService).toContain(
      'export const webSessionCompletionReconciliationSeconds = 2_678_400;',
    );
    expect(authService).toContain(
      'make_interval(secs => $10::integer)',
    );
    expect(existsSync(retentionMigrationPath)).toBe(true);
    if (!existsSync(retentionMigrationPath)) return;
    expect(readFileSync(retentionMigrationPath, 'utf8')).toContain("interval '31 days'");
  });
});
