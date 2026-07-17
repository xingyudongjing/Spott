import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');
const migration0020 = resolve(root, 'database/migrations/0020_sync_correctness.sql');
const migration0021 = resolve(root, 'database/migrations/0021_web_session_security.sql');

describe('0021 Web session security migration', () => {
  it('is additive and contains every security-owned table and trigger', () => {
    expect(existsSync(migration0021)).toBe(true);
    const sql = readFileSync(migration0021, 'utf8');
    expect(sql).toContain('refresh_generation');
    expect(sql).toContain('transport_class');
    expect(sql).toContain('identity.session_refresh_history');
    expect(sql).toContain('identity.web_bff_request_nonces');
    expect(sql).toContain('identity.device_bindings');
    expect(sql).toContain('identity.proof_hash_classes');
    expect(sql).toContain('identity.web_migration_intents');
    expect(sql).toContain('identity.web_legacy_migrations');
    expect(sql).toMatch(/BEFORE\s+UPDATE\s+ON\s+identity\.sessions/i);
    expect(sql).toMatch(/AFTER\s+INSERT\s+ON\s+identity\.sessions/i);
  });

  it('pins the current 0020 source checksum', () => {
    const checksum = createHash('sha256')
      .update(readFileSync(migration0020))
      .digest('hex');
    expect(checksum).toBe('c748cfbcf753f33ddc74aceee68db0ec040f4126f0d5ef2621de55558ac1b984');
  });
});
