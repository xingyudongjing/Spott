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

describe('CommunityController achievement endpoints', () => {
  const awardId = '019b0000-0000-7000-a000-000000000001';
  const otherUser = '019b0000-0000-7000-8000-000000000042';

  it('forwards a validated boolean when hiding a single badge', () => {
    const setAchievementVisibility = vi.fn();
    const controller = new CommunityController({ setAchievementVisibility } as never);

    void controller.hideOne(user, awardId, { hidden: true });

    expect(setAchievementVisibility).toHaveBeenCalledWith(user.id, awardId, true);
  });

  it('rejects a non-uuid award id before calling the service', () => {
    const setAchievementVisibility = vi.fn();
    const controller = new CommunityController({ setAchievementVisibility } as never);

    expect(() => controller.hideOne(user, 'not-a-uuid', { hidden: true })).toThrow();
    expect(setAchievementVisibility).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean hidden flag', () => {
    const setAllAchievementsHidden = vi.fn();
    const controller = new CommunityController({ setAllAchievementsHidden } as never);

    expect(() => controller.hideAll(user, { hidden: 'yes' })).toThrow();
    expect(setAllAchievementsHidden).not.toHaveBeenCalled();
  });

  it('passes the current user as the viewer when reading another member', () => {
    const publicAchievements = vi.fn();
    const controller = new CommunityController({ publicAchievements } as never);

    void controller.publicAchievements(user, otherUser);

    expect(publicAchievements).toHaveBeenCalledWith(otherUser, user.id);
  });

  it('requires the share-card and public-achievement endpoints to be authenticated', () => {
    type Handler = (...arguments_: unknown[]) => unknown;
    for (const name of ['shareCard', 'publicAchievements', 'hideOne', 'hideAll'] as const) {
      const handler = (Object.getOwnPropertyDescriptor(
        CommunityController.prototype,
        name,
      ) as TypedPropertyDescriptor<Handler> | undefined)?.value;
      if (!handler) throw new Error(`${name} handler is missing.`);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
    }
  });
});
