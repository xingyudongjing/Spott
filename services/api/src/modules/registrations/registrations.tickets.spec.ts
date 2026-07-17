import { describe, expect, it, vi } from 'vitest';
import { RegistrationsService } from './registrations.service.js';

const user = {
  id: '019b0000-0000-7000-8000-000000000010',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};
const eventId = '019b0000-0000-7000-8100-000000000010';
const ticketTypeId = '019b0000-0000-7000-8400-000000000010';
const registrationId = '019b0000-0000-7000-8200-000000000010';
const quoteId = '019b0000-0000-7000-9100-000000000010';
const key = '019b0000-0000-7000-9000-000000000010';

function idempotencyStub() {
  return { requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)), claim: vi.fn().mockResolvedValue(null), complete: vi.fn() };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: eventId,
    status: 'published',
    capacity: 50,
    deadline_at: new Date('2099-07-20T00:00:00.000Z'),
    ends_at: new Date('2099-07-21T00:00:00.000Z'),
    registration_mode: 'automatic',
    waitlist_enabled: true,
    confirmed_count: 0,
    pending_count: 0,
    offered_count: 0,
    version: '3',
    server_time: new Date('2026-07-18T00:00:00.000Z'),
    active_ticket_type_count: '1',
    ...overrides,
  };
}

const baseInput = {
  partySize: 1,
  quoteId,
  expectedEventVersion: 3,
  joinWaitlistIfFull: false,
  answers: {},
};

describe('RegistrationsService ticket selection', () => {
  it('requires a ticket selection when the event defines active tiers', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM events.events e JOIN events.event_capacity')) return { rows: [eventRow()] };
        if (text.includes("status IN ('pending','confirmed'")) return { rows: [] };
        if (text.includes('FROM events.registration_questions')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)) };
    const service = new RegistrationsService(database as never, idempotencyStub() as never, {} as never);
    await expect(service.register(user as never, eventId, key, baseInput)).rejects.toMatchObject({
      code: 'TICKET_SELECTION_REQUIRED',
      status: 422,
    });
  });

  it('refuses a tier whose quota is exhausted', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM events.events e JOIN events.event_capacity')) return { rows: [eventRow()] };
        if (text.includes("status IN ('pending','confirmed'")) return { rows: [] };
        if (text.includes('FROM events.registration_questions')) return { rows: [] };
        if (text.includes('FROM events.ticket_types')) {
          return { rows: [{ id: ticketTypeId, quota: 5, sold_count: 5 }] };
        }
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)) };
    const service = new RegistrationsService(database as never, idempotencyStub() as never, {} as never);
    await expect(
      service.register(user as never, eventId, key, { ...baseInput, ticketTypeId }),
    ).rejects.toMatchObject({ code: 'TICKET_SOLD_OUT', status: 409 });
  });

  it('rejects a ticket type that does not belong to the event or is inactive', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM events.events e JOIN events.event_capacity')) return { rows: [eventRow()] };
        if (text.includes("status IN ('pending','confirmed'")) return { rows: [] };
        if (text.includes('FROM events.registration_questions')) return { rows: [] };
        if (text.includes('FROM events.ticket_types')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)) };
    const service = new RegistrationsService(database as never, idempotencyStub() as never, {} as never);
    await expect(
      service.register(user as never, eventId, key, { ...baseInput, ticketTypeId }),
    ).rejects.toMatchObject({ code: 'TICKET_TYPE_UNAVAILABLE', status: 409 });
  });

  it('confirms a tier registration, stores the selection and increments the tier headcount', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (text.includes('FROM events.events e JOIN events.event_capacity')) return { rows: [eventRow()] };
        if (text.includes("status IN ('pending','confirmed'")) return { rows: [] };
        if (text.includes('FROM events.registration_questions')) return { rows: [] };
        if (text.includes('FROM events.ticket_types')) {
          return { rows: [{ id: ticketTypeId, quota: 30, sold_count: 4 }] };
        }
        if (text.includes('SELECT uuidv7() AS id')) return { rows: [{ id: registrationId }] };
        if (text.startsWith('SELECT r.*')) {
          return {
            rows: [{
              id: registrationId, event_id: eventId, user_id: user.id, status: 'confirmed',
              party_size: 1, attendee_note: null, ticket_type_id: ticketTypeId, version: '1',
              waitlist_joined_at: null, updated_at: new Date('2026-07-18T00:00:00.000Z'),
              offer_expires_at: null,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)) };
    const points = {
      consumeQuote: vi.fn().mockResolvedValue(100),
      spend: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RegistrationsService(database as never, idempotencyStub() as never, points as never);
    const body = (await service.register(
      user,
      eventId,
      key,
      { ...baseInput, ticketTypeId },
    )) as Record<string, unknown>;

    expect(body).toMatchObject({ status: 'confirmed', ticketTypeId });
    const insert = calls.find((call) => call.text.includes('INSERT INTO events.registrations'));
    expect(insert?.values).toContain(ticketTypeId);
    const bump = calls.find((call) => call.text.includes('UPDATE events.ticket_types SET sold_count = sold_count + $2'));
    expect(bump).toBeDefined();
    expect(bump?.values).toEqual([ticketTypeId, 1]);
  });

  it('refuses a waitlist promotion when the chosen tier filled while the user waited', async () => {
    const future = new Date('2099-07-19T00:00:00.000Z');
    let bumpedTier = false;
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        void values;
        if (text.startsWith('SELECT r.*')) {
          return {
            rows: [{
              id: registrationId, event_id: eventId, user_id: user.id, status: 'offered',
              party_size: 1, attendee_note: null, ticket_type_id: ticketTypeId, version: '5',
              waitlist_joined_at: new Date('2026-07-18T00:00:00.000Z'),
              updated_at: new Date('2026-07-18T00:00:00.000Z'), offer_expires_at: future,
            }],
          };
        }
        if (text.includes('FROM events.waitlist_promotions promotion')) {
          return { rows: [{ id: '019b0000-0000-7000-8500-000000000010', expires_at: future }] };
        }
        if (text.includes('FROM events.events e JOIN events.event_capacity')) {
          return { rows: [{
            capacity: 50, confirmed_count: 0, offered_count: 1, status: 'published',
            ends_at: future, deadline_at: future, version: '3',
            server_time: new Date('2026-07-18T00:00:00.000Z'),
          }] };
        }
        // The tier is now full: quota 5, already 5 sold.
        if (text.includes('SELECT quota, sold_count FROM events.ticket_types')) {
          return { rows: [{ quota: 5, sold_count: 5 }] };
        }
        if (text.includes('UPDATE events.ticket_types SET sold_count = sold_count + $2')) {
          bumpedTier = true;
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)) };
    const points = { consumeQuote: vi.fn().mockResolvedValue(100), spend: vi.fn().mockResolvedValue(undefined) };
    const service = new RegistrationsService(database as never, idempotencyStub() as never, points as never);

    // Without the quota re-check the tier headcount overflows quota and the
    // CHECK(sold_count <= quota) constraint surfaces as a 500 instead of a clean
    // sold-out error.
    await expect(
      service.acceptWaitlist(user, registrationId, key, {
        quoteId, expectedRegistrationVersion: 5, expectedEventVersion: 3,
      }),
    ).rejects.toMatchObject({ code: 'TICKET_SOLD_OUT', status: 409 });
    expect(bumpedTier).toBe(false);
  });

  it('leaves single-fee events (no active tiers) unchanged and touches no ticket tables', async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes('FROM events.events e JOIN events.event_capacity')) {
          return { rows: [eventRow({ active_ticket_type_count: '0' })] };
        }
        if (text.includes("status IN ('pending','confirmed'")) return { rows: [] };
        if (text.includes('FROM events.registration_questions')) return { rows: [] };
        if (text.includes('SELECT uuidv7() AS id')) return { rows: [{ id: registrationId }] };
        if (text.startsWith('SELECT r.*')) {
          return {
            rows: [{
              id: registrationId, event_id: eventId, user_id: user.id, status: 'confirmed',
              party_size: 1, attendee_note: null, ticket_type_id: null, version: '1',
              waitlist_joined_at: null, updated_at: new Date('2026-07-18T00:00:00.000Z'),
              offer_expires_at: null,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)) };
    const points = { consumeQuote: vi.fn().mockResolvedValue(100), spend: vi.fn().mockResolvedValue(undefined) };
    const service = new RegistrationsService(database as never, idempotencyStub() as never, points as never);
    await service.register(user, eventId, key, baseInput);
    // The event lookup references ticket_types in a subquery, but with no active tiers the flow must
    // neither lock a tier row nor mutate any tier headcount.
    expect(calls.some((text) => text.includes('FROM events.ticket_types\n') || text.includes('UPDATE events.ticket_types'))).toBe(false);
  });
});
