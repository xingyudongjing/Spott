import { describe, expect, it, vi } from 'vitest';
import {
  SessionAuthority,
  type SessionAuthorityClaims,
  type SessionAuthorityRoute,
} from './session-authority.js';

const userId = '019b0000-0000-7000-8000-000000000004';
const anotherUserId = '019b0000-0000-7000-8000-000000000005';
const sessionId = '019b0000-0000-7000-8000-000000000099';

interface DatabaseRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly phone_verified_at: Date | null;
  readonly restriction_flags: string[];
  readonly admin_roles: string[] | null;
}

interface DatabaseResult {
  readonly rows: DatabaseRow[];
  readonly rowCount: number;
}

type QueryBehavior = (sql: string, values: readonly unknown[]) => DatabaseResult | Promise<DatabaseResult>;

const liveRow: DatabaseRow = {
  session_id: sessionId,
  user_id: userId,
  phone_verified_at: null,
  restriction_flags: [],
  admin_roles: null,
};

function result(rows: readonly DatabaseRow[]): DatabaseResult {
  return { rows: [...rows], rowCount: rows.length };
}

function harness(behavior: QueryBehavior = () => result([])) {
  const database = { query: vi.fn(behavior) };
  return {
    database,
    authority: new SessionAuthority(database as never),
  };
}

function boundaryRejectsWhenEnforced(
  requiredSQL: readonly string[],
  leakedRow: DatabaseRow = liveRow,
): QueryBehavior {
  return (sql) => result(requiredSQL.every((fragment) => sql.includes(fragment)) ? [] : [leakedRow]);
}

function queryCall(database: { query: ReturnType<typeof vi.fn> }): [string, readonly unknown[]] {
  expect(database.query).toHaveBeenCalledOnce();
  return database.query.mock.calls[0] as [string, readonly unknown[]];
}

const claims: SessionAuthorityClaims = { sub: userId, sid: sessionId };

describe('SessionAuthority live database authorization', () => {
  it.each([
    ['revoked session', ['session.revoked_at IS NULL']],
    ['reuse-detected session', ['session.reuse_detected_at IS NULL']],
    ['expired session', ['session.expires_at > clock_timestamp()']],
  ] as const)('lets the database reject a %s with its own lifecycle predicate', async (
    _scenario,
    requiredSQL,
  ) => {
    const { authority, database } = harness(boundaryRejectsWhenEnforced(requiredSQL));

    await expect(authority.authorize(claims, 'consumer')).resolves.toBeNull();
    const [sql] = queryCall(database);
    for (const fragment of requiredSQL) expect(sql).toContain(fragment);
  });

  it('rejects an access JWT for a completion-linked session until its disposition is accepted', async () => {
    const requiredSQL = [
      'identity.web_session_completion_outcomes',
      'completion_outcome.session_id = session.id',
      'identity.web_session_completion_dispositions',
      'completion_disposition.attempt_hash = completion_outcome.attempt_hash',
      'completion_disposition.challenge_id = completion_outcome.challenge_id',
      'completion_disposition.device_id = completion_outcome.device_id',
      'completion_disposition.binding_id = completion_outcome.binding_id',
      'completion_disposition.binding_generation = completion_outcome.binding_generation',
      'completion_disposition.session_id = completion_outcome.session_id',
      "completion_disposition.state = 'accepted'",
      'AND NOT EXISTS',
    ] as const;
    const { authority, database } = harness(boundaryRejectsWhenEnforced(requiredSQL));

    await expect(authority.authorize(claims, 'consumer')).resolves.toBeNull();
    const [sql] = queryCall(database);
    for (const fragment of requiredSQL) expect(sql).toContain(fragment);
  });

  it('binds the queried session to both JWT sid and JWT sub', async () => {
    const requiredSQL = ['session.id = $1::uuid', 'session.user_id = $2::uuid'] as const;
    const { authority, database } = harness(boundaryRejectsWhenEnforced(requiredSQL));

    await expect(authority.authorize({ sub: anotherUserId, sid: sessionId }, 'consumer'))
      .resolves.toBeNull();
    const [sql, values] = queryCall(database);
    for (const fragment of requiredSQL) expect(sql).toContain(fragment);
    expect(values).toEqual([sessionId, anotherUserId, 'consumer']);
  });

  it('rejects a session-device owner mismatch through explicit device and user joins', async () => {
    const requiredSQL = [
      'device.id = session.device_id',
      'device.user_id = session.user_id',
      'user_record.id = session.user_id',
    ] as const;
    const { authority, database } = harness(boundaryRejectsWhenEnforced(requiredSQL));

    await expect(authority.authorize(claims, 'consumer')).resolves.toBeNull();
    const [sql] = queryCall(database);
    for (const fragment of requiredSQL) expect(sql).toContain(fragment);
  });

  it.each([
    ['suspended user', "user_record.status = 'active'"],
    ['anonymized user', "user_record.status = 'active'"],
    ['deleted user', 'user_record.deleted_at IS NULL'],
  ] as const)('lets the database reject a %s with the current user-state boundary', async (
    _scenario,
    requiredSQL,
  ) => {
    const { authority, database } = harness(boundaryRejectsWhenEnforced([requiredSQL]));

    await expect(authority.authorize(claims, 'consumer')).resolves.toBeNull();
    const [sql] = queryCall(database);
    expect(sql).toContain(requiredSQL);
  });

  it.each([
    ['blocked device', "device.risk_state <> 'blocked'"],
    ['loginBlocked user', "NOT ('loginBlocked' = ANY(user_record.restriction_flags))"],
  ] as const)('lets the database reject a %s with its risk boundary', async (
    _scenario,
    requiredSQL,
  ) => {
    const { authority, database } = harness(boundaryRejectsWhenEnforced([requiredSQL]));

    await expect(authority.authorize(claims, 'consumer')).resolves.toBeNull();
    const [sql] = queryCall(database);
    expect(sql).toContain(requiredSQL);
  });

  it.each([
    ['consumer request carrying an Ops session', 'consumer', "session.transport_class <> 'ops'"],
    ['Ops request carrying a consumer session', 'ops', "session.transport_class = 'ops'"],
  ] as const)('fails closed for a %s', async (
    _scenario,
    route,
    requiredSQL,
  ) => {
    const { authority, database } = harness(boundaryRejectsWhenEnforced([requiredSQL]));

    await expect(authority.authorize(claims, route)).resolves.toBeNull();
    const [sql, values] = queryCall(database);
    expect(sql).toContain(requiredSQL);
    expect(values).toEqual([sessionId, userId, route]);
  });

  it('returns fresh phone restrictions and active MFA operator roles instead of stale JWT values', async () => {
    const row: DatabaseRow = {
      ...liveRow,
      phone_verified_at: new Date('2026-07-17T00:00:00.000Z'),
      restriction_flags: ['publishBlocked', 'commentBlocked'],
      admin_roles: ['safetyReviewer', 'auditReader'],
    };
    const { authority, database } = harness((sql) => {
      expect(sql).toContain('LEFT JOIN admin.admin_users admin_record');
      expect(sql).toContain('admin_record.disabled_at IS NULL');
      expect(sql).toContain('admin_record.mfa_enrolled_at IS NOT NULL');
      return result([row]);
    });
    const staleClaims = {
      ...claims,
      phoneVerified: false,
      restrictions: ['loginBlocked'],
      roles: ['user'],
    } as SessionAuthorityClaims;

    await expect(authority.authorize(staleClaims, 'ops')).resolves.toEqual({
      id: userId,
      sessionId,
      phoneVerified: true,
      restrictions: ['publishBlocked', 'commentBlocked'],
      roles: ['operator', 'safetyReviewer', 'auditReader'],
    });
    queryCall(database);
  });

  it('maps a disabled admin row filtered by the database to a non-operator user', async () => {
    const { authority, database } = harness((sql) => {
      expect(sql).toContain('admin_record.disabled_at IS NULL');
      return result([{ ...liveRow, admin_roles: null }]);
    });

    await expect(authority.authorize({
      ...claims,
      roles: ['operator', 'securityAdmin'],
    } as SessionAuthorityClaims, 'consumer')).resolves.toEqual({
      id: userId,
      sessionId,
      phoneVerified: false,
      restrictions: [],
      roles: ['user'],
    });
    queryCall(database);
  });

  it('maps an admin row without current MFA filtered by the database to a non-operator user', async () => {
    const { authority, database } = harness((sql) => {
      expect(sql).toContain('admin_record.mfa_enrolled_at IS NOT NULL');
      return result([{ ...liveRow, admin_roles: null }]);
    });

    await expect(authority.authorize(claims, 'consumer')).resolves.toEqual({
      id: userId,
      sessionId,
      phoneVerified: false,
      restrictions: [],
      roles: ['user'],
    });
    queryCall(database);
  });

  it.each([
    [{ sub: '', sid: sessionId }, 'consumer'],
    [{ sub: userId, sid: '' }, 'consumer'],
    [{ sub: userId.toUpperCase(), sid: sessionId }, 'consumer'],
    [{ sub: userId, sid: sessionId }, 'invalid-route'],
  ] as const)('rejects malformed claims or route before querying: %j', async (
    malformed,
    route,
  ) => {
    const { authority, database } = harness();
    await expect(authority.authorize(
      malformed,
      route as SessionAuthorityRoute,
    )).resolves.toBeNull();
    expect(database.query).not.toHaveBeenCalled();
  });
});
