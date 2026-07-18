import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(process.cwd(), '../../database/migrations/0029_event_contact_channels.sql');

describe('0029 event organizer contact migration', () => {
  it('stores only encrypted, scoped organizer contact channels', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE events.event_contact_channels');
    expect(sql).toContain('event_id uuid PRIMARY KEY');
    expect(sql).toContain('value_cipher bytea NOT NULL');
    expect(sql).toContain('label_cipher bytea');
    expect(sql).not.toMatch(/\bvalue_hash\b/i);
    expect(sql).toContain("CHECK (kind IN ('email', 'line', 'website'))");
    expect(sql).toContain('REFERENCES events.events(id) ON DELETE CASCADE');
    expect(sql).not.toMatch(/\blabel\s+text|value_(?:plain|text)|contact_value\s+text/i);
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });
});
