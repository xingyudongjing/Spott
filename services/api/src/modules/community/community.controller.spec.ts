import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../platform/request-context.js';
import { CommunityController } from './community.controller.js';

describe('CommunityController feedback privacy', () => {
  it('exposes only the aggregate feedback summary as a public endpoint', () => {
    type Handler = (...arguments_: unknown[]) => unknown;
    const summary = (Object.getOwnPropertyDescriptor(
      CommunityController.prototype,
      'summary',
    ) as TypedPropertyDescriptor<Handler> | undefined)?.value;
    const privateFeedback = (Object.getOwnPropertyDescriptor(
      CommunityController.prototype,
      'privateFeedback',
    ) as TypedPropertyDescriptor<Handler> | undefined)?.value;
    if (!summary || !privateFeedback) throw new Error('Community controller handlers are missing.');
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, summary)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, privateFeedback)).not.toBe(true);
  });
});

const user = {
  id: '019b0000-0000-7000-8000-000000000001',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};

describe('CommunityController feedback reliability contract', () => {
  const registrationId = '019b0000-0000-7000-8100-000000000001';
  const key = '019b0000-0000-7000-9000-000000000001';
  const input = {
    attendanceRating: 5,
    tags: ['friendly'],
    visibility: 'aggregate_only',
  };

  it.each([undefined, '', 'not-a-uuid'])('requires a valid Idempotency-Key (%s)', (invalidKey) => {
    const feedback = vi.fn();
    const controller = new CommunityController({ feedback } as never);

    expect(() => controller.feedback(user as never, registrationId, invalidKey as never, input)).toThrow();
    expect(feedback).not.toHaveBeenCalled();
  });

  it('forwards the validated idempotency key and input', () => {
    const feedback = vi.fn();
    const controller = new CommunityController({ feedback } as never);

    void controller.feedback(user, registrationId, key, input);

    expect(feedback).toHaveBeenCalledWith(user.id, registrationId, key, input);
  });

  it('provides an authenticated current-user feedback endpoint', () => {
    const ownFeedback = vi.fn();
    const controller = new CommunityController({ ownFeedback } as never);

    void controller.ownFeedback(user, registrationId);

    expect(ownFeedback).toHaveBeenCalledWith(user.id, registrationId);
    type Handler = (...arguments_: unknown[]) => unknown;
    const handler = (Object.getOwnPropertyDescriptor(
      CommunityController.prototype,
      'ownFeedback',
    ) as TypedPropertyDescriptor<Handler> | undefined)?.value;
    if (!handler) throw new Error('Own feedback handler is missing.');
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
  });
});
