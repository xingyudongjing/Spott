import { describe, expect, it, vi } from 'vitest';
import { RegistrationsController } from './registrations.controller.js';

const user = {
  id: '019b0000-0000-7000-8000-000000000001',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};

describe('RegistrationsController registration contract', () => {
  it('requires the event version the user reviewed', () => {
    const register = vi.fn();
    const controller = new RegistrationsController({ register } as never);

    expect(() => controller.register(
      user as never,
      '019b0000-0000-7000-8100-000000000001',
      '019b0000-0000-7000-9000-000000000001',
      {
        partySize: 1,
        quoteId: '019b0000-0000-7000-9100-000000000001',
        joinWaitlistIfFull: false,
        answers: {},
      },
    )).toThrow();
    expect(register).not.toHaveBeenCalled();
  });
});

describe('RegistrationsController waitlist acceptance contract', () => {
  const registrationId = '019b0000-0000-7000-8200-000000000001';
  const key = '019b0000-0000-7000-9000-000000000002';
  const input = {
    quoteId: '019b0000-0000-7000-9100-000000000002',
    expectedRegistrationVersion: 3,
    expectedEventVersion: 8,
  };

  it.each([
    ['quoteId', { expectedRegistrationVersion: 3, expectedEventVersion: 8 }],
    ['expectedRegistrationVersion', { quoteId: input.quoteId, expectedEventVersion: 8 }],
    ['expectedEventVersion', { quoteId: input.quoteId, expectedRegistrationVersion: 3 }],
  ])('requires %s in the request body', (_field, body) => {
    const acceptWaitlist = vi.fn();
    const controller = new RegistrationsController({ acceptWaitlist } as never);

    expect(() => controller.acceptWaitlist(user as never, registrationId, key, body)).toThrow();
    expect(acceptWaitlist).not.toHaveBeenCalled();
  });

  it('forwards the reviewed quote and versions to the service', () => {
    const acceptWaitlist = vi.fn();
    const controller = new RegistrationsController({ acceptWaitlist } as never);

    void controller.acceptWaitlist(user, registrationId, key, input);

    expect(acceptWaitlist).toHaveBeenCalledWith(user, registrationId, key, input);
  });
});
