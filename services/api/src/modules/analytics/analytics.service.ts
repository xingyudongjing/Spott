import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { Database } from '../../platform/database.js';

const forbidden = /(^|_)(phone|email|address|otp|code|token|password|evidence|statement|body|message)($|_)/i;

@Injectable()
export class AnalyticsService {
  constructor(private readonly database: Database) {}

  async ingest(userId: string | undefined, events: Array<{
    eventName: string; schemaVersion: number; anonymousId?: string | undefined; sessionId: string;
    platform: string; properties: Record<string, unknown>; traceId?: string | undefined; occurredAt: string;
  }>): Promise<unknown> {
    for (const event of events) {
      if (this.hasForbiddenKey(event.properties)) {
        throw new DomainError('ANALYTICS_PII_REJECTED', '埋点包含不允许采集的敏感字段。', 400);
      }
      const occurredAt = new Date(event.occurredAt);
      if (Math.abs(Date.now() - occurredAt.getTime()) > 7 * 86_400_000) {
        throw new DomainError('ANALYTICS_TIME_INVALID', '埋点时间超出允许范围。', 400);
      }
    }
    await this.database.transaction(async (client) => {
      for (const event of events) {
        await client.query(
          `INSERT INTO analytics.product_events(
             event_name, schema_version, anonymous_id, user_id, session_id,
             platform, properties, trace_id, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [event.eventName, event.schemaVersion, event.anonymousId ?? null, userId ?? null, event.sessionId, event.platform, event.properties, event.traceId ?? null, event.occurredAt],
        );
      }
    });
    return { accepted: events.length, serverTime: new Date().toISOString() };
  }

  private hasForbiddenKey(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => this.hasForbiddenKey(item));
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => forbidden.test(key) || this.hasForbiddenKey(child));
  }
}
