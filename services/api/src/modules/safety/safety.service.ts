import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { Database } from '../../platform/database.js';
import { FieldCrypto } from '../../platform/crypto.js';

@Injectable()
export class SafetyService {
  constructor(
    private readonly database: Database,
    private readonly crypto: FieldCrypto,
  ) {}

  async report(
    reporterId: string,
    input: {
      targetType: string;
      targetId: string;
      reason: string;
      details?: string | undefined;
      evidenceAssetIds: string[];
    },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const severity = this.severity(input.reason, input.details);
      const reference = `SPT-${new Date().getUTCFullYear()}-${randomBytes(6).toString('hex').toUpperCase()}`;
      const report = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO safety.reports(
           public_reference, reporter_id, target_type, target_id, reason,
           details_cipher, severity
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
        [
          reference,
          reporterId,
          input.targetType,
          input.targetId,
          input.reason,
          input.details ? this.crypto.encrypt(input.details) : null,
          severity,
        ],
      );
      const row = report.rows[0];
      if (!row) throw new DomainError('REPORT_CREATE_FAILED', '举报提交失败。', 500, { retryable: true });
      for (const assetId of input.evidenceAssetIds) {
        await client.query(
          `INSERT INTO safety.evidence_assets(
             report_id, asset_id, kms_key_ref, content_hash, retention_until
           ) VALUES ($1,$2,'alias/spott-restricted-evidence',digest($2::text,'sha256'),
             clock_timestamp() + interval '365 days')`,
          [row.id, assetId],
        );
      }
      const sla = severity === 'p0' ? '1 hour' : severity === 'p1' ? '24 hours' : '72 hours';
      await client.query(
        `INSERT INTO safety.moderation_cases(report_id, sla_due_at)
         VALUES ($1, clock_timestamp() + $2::interval)`,
        [row.id, sla],
      );
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('safety.report', $1, 'report.created', $2)`,
        [row.id, { reportId: row.id, severity }],
      );
      return { reference, status: 'open', submittedAt: row.created_at.toISOString() };
    });
  }

  async appeal(
    userId: string,
    input: { caseId?: string | undefined; caseReference?: string | undefined; statement: string },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const caseResult = await client.query<{
        id: string;
        public_reference: string;
        status: string;
      }>(
        `SELECT moderation_case.id, report.public_reference, moderation_case.status
         FROM safety.moderation_cases moderation_case
         JOIN safety.reports report ON report.id = moderation_case.report_id
         WHERE (
           ($1::uuid IS NOT NULL AND moderation_case.id = $1)
           OR ($2::text IS NOT NULL AND report.public_reference = $2)
         )
           AND (
             report.reporter_id = $3
             OR (report.target_type = 'user' AND report.target_id = $3)
           )
         FOR UPDATE OF moderation_case`,
        [input.caseId ?? null, input.caseReference ?? null, userId],
      );
      const moderationCase = caseResult.rows[0];
      if (!moderationCase) {
        throw new DomainError('SAFETY_CASE_NOT_FOUND', '未找到可访问的安全处理记录。', 404);
      }
      const existing = await client.query<{ id: string; status: string; created_at: Date }>(
        `SELECT id, status, created_at FROM safety.appeals
         WHERE case_id = $1 AND appellant_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [moderationCase.id, userId],
      );
      if (existing.rows[0]) {
        return {
          id: existing.rows[0].id,
          caseReference: moderationCase.public_reference,
          status: existing.rows[0].status,
          createdAt: existing.rows[0].created_at.toISOString(),
        };
      }
      if (!['decided', 'closed'].includes(moderationCase.status)) {
        throw new DomainError('APPEAL_NOT_ALLOWED', '当前处理决定不能申诉。', 422);
      }
      const result = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO safety.appeals(case_id, appellant_id, statement)
         VALUES ($1,$2,$3) RETURNING id, created_at`,
        [moderationCase.id, userId, input.statement],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('APPEAL_CREATE_FAILED', '申诉提交失败。', 500, { retryable: true });
      await client.query(
        `UPDATE safety.moderation_cases SET status = 'appealed' WHERE id = $1`,
        [moderationCase.id],
      );
      await client.query(
        `UPDATE safety.reports SET status = 'appealed', updated_at = clock_timestamp()
         WHERE id = (SELECT report_id FROM safety.moderation_cases WHERE id = $1)`,
        [moderationCase.id],
      );
      return {
        id: row.id,
        caseReference: moderationCase.public_reference,
        status: 'pending',
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  async cases(userId: string): Promise<unknown> {
    const result = await this.database.query<{
      public_reference: string;
      relationship: 'submitted' | 'subject';
      target_type: string;
      target_id: string;
      reason: string;
      severity: string;
      report_status: string;
      case_status: string | null;
      decision: string | null;
      sla_due_at: Date | null;
      created_at: Date;
      updated_at: Date;
      appeal_id: string | null;
      appeal_status: string | null;
      appeal_created_at: Date | null;
      appeal_decided_at: Date | null;
    }>(
      `SELECT report.public_reference,
         CASE WHEN report.reporter_id = $1 THEN 'submitted' ELSE 'subject' END AS relationship,
         report.target_type, report.target_id, report.reason, report.severity,
         report.status AS report_status, moderation_case.status AS case_status,
         moderation_case.decision, moderation_case.sla_due_at,
         report.created_at, report.updated_at,
         appeal.id AS appeal_id, appeal.status AS appeal_status,
         appeal.created_at AS appeal_created_at, appeal.decided_at AS appeal_decided_at
       FROM safety.reports report
       LEFT JOIN safety.moderation_cases moderation_case ON moderation_case.report_id = report.id
       LEFT JOIN LATERAL (
         SELECT id, status, created_at, decided_at FROM safety.appeals
         WHERE case_id = moderation_case.id AND appellant_id = $1
         ORDER BY created_at DESC LIMIT 1
       ) appeal ON true
       WHERE report.reporter_id = $1
         OR (report.target_type = 'user' AND report.target_id = $1)
       ORDER BY report.updated_at DESC, report.id DESC
       LIMIT 100`,
      [userId],
    );
    return {
      items: result.rows.map((row) => ({
        reference: row.public_reference,
        relationship: row.relationship,
        targetType: row.target_type,
        targetId: row.target_id,
        reason: row.reason,
        severity: row.severity,
        status: row.report_status,
        caseStatus: row.case_status,
        decision: row.decision,
        slaDueAt: row.sla_due_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        appeal: row.appeal_id
          ? {
              id: row.appeal_id,
              status: row.appeal_status,
              createdAt: row.appeal_created_at?.toISOString() ?? null,
              decidedAt: row.appeal_decided_at?.toISOString() ?? null,
            }
          : null,
      })),
    };
  }

  async blocks(userId: string): Promise<unknown> {
    const result = await this.database.query<{
      user_id: string;
      public_handle: string;
      nickname: string | null;
      reason_code: string | null;
      created_at: Date;
    }>(
      `SELECT blocked.id AS user_id, blocked.public_handle, profile.nickname,
         block.reason_code, block.created_at
       FROM identity.blocks block
       JOIN identity.users blocked ON blocked.id = block.blocked_id
       LEFT JOIN identity.profiles profile ON profile.user_id = blocked.id
       WHERE block.blocker_id = $1 ORDER BY block.created_at DESC`,
      [userId],
    );
    return {
      items: result.rows.map((row) => ({
        userId: row.user_id,
        publicHandle: row.public_handle,
        nickname: row.nickname,
        reason: row.reason_code,
        blockedAt: row.created_at.toISOString(),
      })),
    };
  }

  async setBlock(blockerId: string, identifier: string, blocked: boolean, reason?: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const target = await client.query<{ id: string }>(
        `SELECT id FROM identity.users
         WHERE (id::text = $1 OR public_handle = $1) AND deleted_at IS NULL`,
        [identifier],
      );
      const blockedId = target.rows[0]?.id;
      if (!blockedId) throw new DomainError('USER_NOT_FOUND', '用户不存在。', 404);
      if (blockedId === blockerId) throw new DomainError('BLOCK_SELF_FORBIDDEN', '不能拉黑自己。', 422);
      if (blocked) {
        await client.query(
          `INSERT INTO identity.blocks(blocker_id, blocked_id, reason_code)
           VALUES ($1,$2,$3)
           ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET reason_code = EXCLUDED.reason_code`,
          [blockerId, blockedId, reason ?? null],
        );
        await client.query(
          `UPDATE identity.follows SET deleted_at = COALESCE(deleted_at, clock_timestamp())
           WHERE deleted_at IS NULL AND (
             (follower_id = $1 AND target_type = 'user' AND target_id = $2)
             OR (follower_id = $2 AND target_type = 'user' AND target_id = $1)
           )`,
          [blockerId, blockedId],
        );
      } else {
        await client.query('DELETE FROM identity.blocks WHERE blocker_id = $1 AND blocked_id = $2', [
          blockerId,
          blockedId,
        ]);
      }
      await client.query(
        `SELECT sync.record_change($1, 'block.changed', 'profile', $2, 'upsert', 1,
           ARRAY['blocked'], jsonb_build_object('blocked', $3::boolean))`,
        [blockerId, blockedId, blocked],
      );
      return { userId: blockedId, blocked };
    });
  }

  private severity(reason: string, details?: string): 'p0' | 'p1' | 'p2' {
    const text = `${reason} ${details ?? ''}`.toLowerCase();
    if (/人身|未成年|诈骗|violence|minor|fraud/.test(text)) return 'p0';
    if (/骚扰|危险|仇恨|harass|danger|hate/.test(text)) return 'p1';
    return 'p2';
  }
}
