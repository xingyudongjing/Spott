import { describe, expect, it } from "vitest";

import { notificationHref } from "../app/lib/notification-routing";

function item(
  type: string,
  resourceType: string | null = null,
  resourcePublicId: string | null = null,
) {
  return { type, resourceType, resourcePublicId };
}

describe("notification routing", () => {
  it("opens the resource the notification is about", () => {
    expect(notificationHref(item("event.cancelled", "event", "evening-walk"))).toBe(
      "/e/evening-walk",
    );
    expect(notificationHref(item("group.announcement", "group", "019b-group"))).toBe(
      "/g/019b-group",
    );
    expect(notificationHref(item("moderation.decided", "user", "019b-user"))).toBe("/u/019b-user");
  });

  it("sends registration notifications to the itinerary, the page that shows their state", () => {
    expect(notificationHref(item("waitlist.offered", "registration", "019b-reg"))).toBe(
      "/me/events",
    );
  });

  it("falls back to the type family when no resource is attached", () => {
    expect(notificationHref(item("points.expiring"))).toBe("/me/wallet");
    expect(notificationHref(item("achievements.awarded"))).toBe("/me/achievements");
    expect(notificationHref(item("safety.case"))).toBe("/safety");
    expect(notificationHref(item("account.restricted"))).toBe("/safety");
    expect(notificationHref(item("group.dissolution_scheduled"))).toBe("/groups");
    expect(notificationHref(item("something.unknown"))).toBe("/me/events");
  });

  it("ignores an empty or unknown resource instead of building a broken link", () => {
    expect(notificationHref(item("points.adjusted", "event", "  "))).toBe("/me/wallet");
    expect(notificationHref(item("event.reminder", "ticket", "019b-ticket"))).toBe("/me/events");
  });

  it("escapes identifiers taken from the payload", () => {
    expect(notificationHref(item("event.reminder", "event", "a b/c"))).toBe("/e/a%20b%2Fc");
  });
});
