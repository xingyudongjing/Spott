import { describe, expect, it } from 'vitest';
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
