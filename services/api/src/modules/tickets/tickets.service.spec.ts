import { describe, expect, it, vi } from 'vitest';
import { TicketsService } from './tickets.service.js';

const organizer = {
  id: '019b0000-0000-7000-8000-000000000001',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};
const stranger = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};
const eventId = '019b0000-0000-7000-8100-000000000001';
const registrationId = '019b0000-0000-7000-8200-000000000001';

function transactionDatabase(handler: (text: string, values: readonly unknown[]) => unknown) {
  const client = {
    query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
      const rows = handler(text, values);
      return { rows: rows ?? [], rowCount: Array.isArray(rows) ? rows.length : 0 };
    }),
  };
  const database = {
    query: client.query,
    transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)),
  };
  return { database, client };
}

describe('TicketsService.create', () => {
  it('rejects a non-organizer who is not an operator', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('SELECT organizer_id FROM events.events')) {
        return [{ organizer_id: organizer.id }];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    await expect(
      service.create(stranger as never, eventId, { name: 'GA', isFree: true }),
    ).rejects.toMatchObject({ code: 'TICKET_MANAGE_FORBIDDEN', status: 403 });
  });

  it('rejects a paid tier that discloses no collector or method (non-custody money shape)', async () => {
    const { database } = transactionDatabase(() => []);
    const service = new TicketsService(database as never);
    await expect(
      service.create(organizer as never, eventId, { name: 'VIP', isFree: false, amountJPY: 5000 }),
    ).rejects.toMatchObject({ code: 'TICKET_TYPE_INVALID', status: 400 });
  });

  it('rejects a free tier that carries a price', async () => {
    const { database } = transactionDatabase(() => []);
    const service = new TicketsService(database as never);
    await expect(
      service.create(organizer as never, eventId, { name: 'GA', isFree: true, amountJPY: 1000 }),
    ).rejects.toMatchObject({ code: 'TICKET_TYPE_INVALID', status: 400 });
  });

  it('assigns the next sort order and inserts a valid paid tier', async () => {
    const inserted: unknown[][] = [];
    const { database } = transactionDatabase((text, values) => {
      if (text.includes('SELECT organizer_id FROM events.events')) return [{ organizer_id: organizer.id }];
      if (text.includes('FROM admin.config_revisions')) return [];
      if (text.includes('next_sort')) return [{ count: '2', next_sort: 2 }];
      if (text.startsWith('INSERT INTO events.ticket_types')) {
        inserted.push([...values]);
        return [{
          id: '019b0000-0000-7000-8300-000000000001', event_id: eventId, name: 'VIP',
          description: null, is_free: false, amount_jpy: '5000', collector_name: '主办方',
          method: 'PayPay', payment_deadline_text: null, refund_policy: '不退', quota: 30,
          sold_count: 0, sort_order: 2, active: true, updated_at: new Date('2026-07-18T00:00:00.000Z'),
        }];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    const view = (await service.create(organizer, eventId, {
      name: 'VIP', isFree: false, amountJPY: 5000, collectorName: '主办方', method: 'PayPay',
      refundPolicy: '不退', quota: 30,
    })) as Record<string, unknown>;
    expect(view).toMatchObject({ amountJPY: 5000, quota: 30, remaining: 30, soldOut: false, sortOrder: 2 });
    expect(inserted[0]?.[10]).toBe(2); // sort_order param
    expect(view.availableActions).toContain('selectTicket');
  });

  it('enforces the configurable per-event ticket type limit', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('SELECT organizer_id FROM events.events')) return [{ organizer_id: organizer.id }];
      if (text.includes('FROM admin.config_revisions')) return [{ value_json: 2 }];
      if (text.includes('next_sort')) return [{ count: '2', next_sort: 2 }];
      return [];
    });
    const service = new TicketsService(database as never);
    await expect(
      service.create(organizer as never, eventId, { name: 'Extra', isFree: true }),
    ).rejects.toMatchObject({ code: 'TICKET_TYPE_LIMIT_REACHED', status: 409 });
  });
});

describe('TicketsService.list', () => {
  it('returns active tiers with remaining headcount and sold-out flags', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('SELECT id FROM events.events')) return [{ id: eventId }];
      if (text.includes('FROM events.ticket_types')) {
        return [
          {
            id: 't1', event_id: eventId, name: 'GA', description: null, is_free: true,
            amount_jpy: null, collector_name: null, method: null, payment_deadline_text: null,
            refund_policy: null, quota: 10, sold_count: 4, sort_order: 0, active: true,
            updated_at: new Date('2026-07-18T00:00:00.000Z'),
          },
          {
            id: 't2', event_id: eventId, name: 'VIP', description: null, is_free: false,
            amount_jpy: '8000', collector_name: '主办方', method: 'PayPay',
            payment_deadline_text: null, refund_policy: '不退', quota: 5, sold_count: 5,
            sort_order: 1, active: true, updated_at: new Date('2026-07-18T00:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    const result = (await service.list(eventId)) as { items: Array<Record<string, unknown>> };
    expect(result.items[0]).toMatchObject({ name: 'GA', remaining: 6, soldOut: false });
    expect(result.items[0]!.availableActions).toContain('selectTicket');
    expect(result.items[1]).toMatchObject({ name: 'VIP', remaining: 0, soldOut: true, amountJPY: 8000 });
    expect(result.items[1]!.availableActions).not.toContain('selectTicket');
  });
});

describe('TicketsService payment status records', () => {
  it('rejects self-reporting payment for a free registration', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('FROM events.registrations r')) {
        return [{ user_id: organizer.id, status: 'confirmed', tier_free: null, event_free: true }];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    await expect(
      service.reportPayment(organizer as never, registrationId),
    ).rejects.toMatchObject({ code: 'TICKET_PAYMENT_NOT_APPLICABLE', status: 409 });
  });

  it('rejects self-reporting payment on someone else\'s registration', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('FROM events.registrations r')) {
        return [{ user_id: organizer.id, status: 'confirmed', tier_free: false, event_free: null }];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    await expect(
      service.reportPayment(stranger as never, registrationId),
    ).rejects.toMatchObject({ code: 'REGISTRATION_FORBIDDEN', status: 403 });
  });

  it('records a self-reported off-platform payment for a paid tier', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('FROM events.registrations r')) {
        return [{ user_id: organizer.id, status: 'confirmed', tier_free: false, event_free: null }];
      }
      if (text.includes('SET payment_self_reported_at')) {
        return [{ payment_self_reported_at: new Date('2026-07-18T01:00:00.000Z') }];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    const result = (await service.reportPayment(organizer, registrationId)) as Record<string, unknown>;
    expect(result).toMatchObject({ paymentStatus: 'self_reported' });
  });

  it('only lets the organizer confirm an off-platform payment', async () => {
    const { database } = transactionDatabase((text) => {
      if (text.includes('FROM events.registrations r')) {
        return [{ organizer_id: organizer.id, status: 'confirmed', payment_self_reported_at: new Date() }];
      }
      return [];
    });
    const service = new TicketsService(database as never);
    await expect(
      service.confirmPayment(stranger as never, registrationId),
    ).rejects.toMatchObject({ code: 'TICKET_PAYMENT_CONFIRM_FORBIDDEN', status: 403 });
  });
});
