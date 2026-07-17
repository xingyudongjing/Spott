import { Injectable } from '@nestjs/common';
import { Database } from './database.js';
import type { AuthenticatedUser } from './request-context.js';

const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SessionAuthorityClaims {
  readonly sub: string;
  readonly sid: string;
}

export type SessionAuthorityRoute = 'consumer' | 'ops';

interface SessionAuthorityRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly phone_verified_at: Date | null;
  readonly restriction_flags: string[];
  readonly admin_roles: string[] | null;
}

@Injectable()
export class SessionAuthority {
  constructor(private readonly database: Database) {}

  async authorize(
    claims: SessionAuthorityClaims,
    route: SessionAuthorityRoute,
  ): Promise<AuthenticatedUser | null> {
    if (!this.validClaims(claims) || (route !== 'consumer' && route !== 'ops')) return null;

    const result = await this.database.query<SessionAuthorityRow>(`
      SELECT
        session.id AS session_id,
        user_record.id AS user_id,
        user_record.phone_verified_at,
        user_record.restriction_flags,
        admin_record.roles AS admin_roles
      FROM identity.sessions session
      JOIN identity.devices device
        ON device.id = session.device_id
       AND device.user_id = session.user_id
      JOIN identity.users user_record
        ON user_record.id = session.user_id
      LEFT JOIN admin.admin_users admin_record
        ON admin_record.identity_user_id = user_record.id
       AND admin_record.disabled_at IS NULL
       AND admin_record.mfa_enrolled_at IS NOT NULL
      WHERE session.id = $1::uuid
        AND session.user_id = $2::uuid
        AND session.revoked_at IS NULL
        AND session.reuse_detected_at IS NULL
        AND session.expires_at > clock_timestamp()
        AND device.risk_state <> 'blocked'
        AND user_record.status = 'active'
        AND user_record.deleted_at IS NULL
        AND NOT ('loginBlocked' = ANY(user_record.restriction_flags))
        AND (
          ($3::text = 'ops' AND session.transport_class = 'ops')
          OR ($3::text = 'consumer' AND session.transport_class <> 'ops')
        )
      LIMIT 1
    `, [claims.sid, claims.sub, route]);
    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.user_id,
      sessionId: row.session_id,
      phoneVerified: row.phone_verified_at !== null,
      restrictions: [...row.restriction_flags],
      roles: row.admin_roles === null
        ? ['user']
        : [...new Set(['operator', ...row.admin_roles])],
    };
  }

  private validClaims(claims: SessionAuthorityClaims): boolean {
    return canonicalUUIDPattern.test(claims.sub) && canonicalUUIDPattern.test(claims.sid);
  }
}
