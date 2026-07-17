import { describe, expect, it } from 'vitest';
import { notificationDeepLink } from '../src/jobs.js';

describe('notificationDeepLink', () => {
  it('routes event notifications to the event deep link', () => {
    expect(notificationDeepLink('event.cancelled', 'tokyo-picnic')).toBe('spott://e/tokyo-picnic');
    expect(notificationDeepLink('waitlist.offered', 'tokyo-picnic')).toBe('spott://e/tokyo-picnic');
  });

  it('routes group notifications to the group deep link', () => {
    expect(notificationDeepLink('group.announcement', 'hikers')).toBe('spott://g/hikers');
    expect(notificationDeepLink('group.dissolution_scheduled', 'hikers')).toBe('spott://g/hikers');
  });

  it('percent-encodes the resource id', () => {
    expect(notificationDeepLink('event.cancelled', 'a/b c')).toBe('spott://e/a%2Fb%20c');
  });

  it('returns null when there is no canonical destination or no resource id', () => {
    expect(notificationDeepLink('moderation.decided', 'case-1')).toBeNull();
    expect(notificationDeepLink('achievements.awarded', 'badge-1')).toBeNull();
    expect(notificationDeepLink('event.cancelled', null)).toBeNull();
  });
});
