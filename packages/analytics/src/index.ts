import { z } from 'zod';

export const productEventSchema = z.object({
  eventName: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  schemaVersion: z.number().int().positive().default(1),
  anonymousId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  sessionId: z.string().uuid(),
  platform: z.enum(['ios', 'web', 'ops', 'server']),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  traceId: z.string().max(120).optional(),
  occurredAt: z.iso.datetime(),
});

export type ProductEvent = z.infer<typeof productEventSchema>;
export type AnalyticsConsent = 'denied' | 'essential' | 'analytics';

const forbiddenKeys = /(^|_)(email|phone|address|exact_address|name|message|report_details|token|password)($|_)/i;
const essentialEvents = new Set(['privacy_consent_updated', 'security_action_completed', 'account_deletion_requested']);

export function validateAndScrub(event: ProductEvent): ProductEvent {
  const parsed = productEventSchema.parse(event);
  const properties = Object.fromEntries(Object.entries(parsed.properties).filter(([key]) => !forbiddenKeys.test(key)));
  return { ...parsed, properties };
}

export interface AnalyticsTransport { send(events: readonly ProductEvent[]): Promise<void> }

export class AnalyticsClient {
  private queue: ProductEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly transport: AnalyticsTransport,
    private consent: AnalyticsConsent,
    private readonly batchSize = 20,
  ) {}

  setConsent(consent: AnalyticsConsent): void {
    this.consent = consent;
    if (consent === 'denied') this.queue = this.queue.filter((event) => essentialEvents.has(event.eventName));
  }

  track(event: ProductEvent): void {
    if (this.consent === 'denied' && !essentialEvents.has(event.eventName)) return;
    if (this.consent === 'essential' && !essentialEvents.has(event.eventName)) return;
    this.queue.push(validateAndScrub(event));
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 5_000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);
    try { await this.transport.send(batch); }
    catch (error) { this.queue.unshift(...batch); throw error; }
  }
}

export class HTTPAnalyticsTransport implements AnalyticsTransport {
  constructor(private readonly endpoint: string, private readonly fetcher: typeof fetch = globalThis.fetch) {}
  async send(events: readonly ProductEvent[]): Promise<void> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }), keepalive: true,
    });
    if (!response.ok) throw new Error(`Analytics transport failed: ${response.status}`);
  }
}
