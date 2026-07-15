import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');

describe('registration itinerary database index', () => {
  it('indexes active user registrations in keyset order', () => {
    const migration = readFileSync(
      resolve(repositoryRoot, 'database/migrations/0019_itinerary_registration_index.sql'),
      'utf8',
    );

    expect(migration).toMatch(
      /CREATE INDEX(?: IF NOT EXISTS)?\s+\w+\s+ON events\.registrations\s*\(\s*user_id\s*,\s*updated_at DESC\s*,\s*id DESC\s*\)\s*WHERE deleted_at IS NULL/i,
    );
  });
});
