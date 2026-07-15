import { describe, expect, it } from 'vitest';
import {
  DomainError,
  allocatePointSpend,
  assertBalancedEntries,
  availableEventActions,
  canReadExactAddress,
  transitionEvent,
  validateSyncPage,
} from '../src/index.js';

describe('event state machine', () => {
  it('accepts documented transitions and rejects shortcuts', () => {
    expect(transitionEvent('draft', 'pending_review')).toBe('pending_review');
    expect(() => transitionEvent('draft', 'published')).toThrowError(DomainError);
    expect(() => transitionEvent('cancelled', 'published')).toThrowError(
      /不能从 cancelled 进入 published/,
    );
  });
});

describe('double bucket ledger allocation', () => {
  it('spends expiring free lots, then free, then paid', () => {
    const now = new Date('2026-07-15T00:00:00Z');
    const allocations = allocatePointSpend(
      [
        { id: 'paid', bucket: 'paid', available: 100n },
        { id: 'free-late', bucket: 'free', available: 10n, expiresAt: new Date('2026-08-01') },
        { id: 'free-soon', bucket: 'free', available: 5n, expiresAt: new Date('2026-07-20') },
      ],
      18n,
      now,
    );
    expect(allocations).toEqual([
      { lotId: 'free-soon', bucket: 'free', amount: 5n },
      { lotId: 'free-late', bucket: 'free', amount: 10n },
      { lotId: 'paid', bucket: 'paid', amount: 3n },
    ]);
  });

  it('requires algebraically balanced immutable entries', () => {
    expect(() =>
      assertBalancedEntries([
        { accountCode: 'user', bucket: 'free', amount: 10n },
        { accountCode: 'platform', bucket: 'free', amount: -10n },
      ]),
    ).not.toThrow();
    expect(() =>
      assertBalancedEntries([
        { accountCode: 'user', bucket: 'free', amount: 10n },
        { accountCode: 'platform', bucket: 'free', amount: -9n },
      ]),
    ).toThrowError(/不平衡/);
  });
});

describe('server-driven policy', () => {
  const resource = {
    organizerId: 'host',
    status: 'published' as const,
    registrationOpen: true,
    waitlistEnabled: true,
    isFull: false,
  };

  it('gates high trust actions on phone verification and restrictions', () => {
    expect(
      availableEventActions(
        {
          authenticated: true,
          phoneVerified: true,
          roles: ['verified'],
          restrictions: new Set(),
          userId: 'guest',
        },
        resource,
      ),
    ).toContain('register');

    expect(
      availableEventActions(
        {
          authenticated: true,
          phoneVerified: false,
          roles: ['user'],
          restrictions: new Set(),
          userId: 'guest',
        },
        resource,
      ),
    ).not.toContain('register');
  });

  it('never exposes exact address to unauthorized or removed views', () => {
    expect(canReadExactAddress('confirmed', 'published')).toBe(true);
    expect(canReadExactAddress('pending', 'published')).toBe(false);
    expect(canReadExactAddress('confirmed', 'removed')).toBe(false);
  });

  it('replaces registration actions with ticket actions for participants', () => {
    expect(
      availableEventActions(
        {
          authenticated: true,
          phoneVerified: true,
          roles: ['verified'],
          restrictions: new Set(),
          userId: 'guest',
        },
        { ...resource, registrationStatus: 'confirmed' },
      ),
    ).toEqual(['cancelRegistration', 'viewTicket']);
  });
});

describe('sync cursor validation', () => {
  it('rejects replayed or unordered changes', () => {
    expect(() =>
      validateSyncPage(5, {
        nextCursor: 6,
        hasMore: false,
        serverTime: '2026-07-15T00:00:00Z',
        changes: [
          {
            seq: 5,
            entityType: 'event',
            entityId: '1',
            operation: 'upsert',
            version: 2,
            changedFields: [],
            payload: {},
          },
        ],
      }),
    ).toThrowError(/严格递增/);
  });
});
