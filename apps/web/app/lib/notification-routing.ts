/**
 * Where a notification opens.
 *
 * The API sends `resourceType` / `resourcePublicId` alongside the notification
 * type (see `notification.list`). iOS routes on the resource first and falls back
 * to the type family (Spott/Features/Profile/NotificationsView.swift); the web
 * dashboard mirrors that so the same notification lands on the same subject on
 * both platforms.
 */

import type { NotificationView } from "./client-api";

type RoutableNotification = Pick<NotificationView, "type" | "resourceType" | "resourcePublicId">;

const SAFETY_TYPES = new Set(["moderation.decided", "account.restricted"]);

export function notificationHref(item: RoutableNotification): string {
  const resource = resourceHref(item);
  if (resource) return resource;
  return typeHref(item.type);
}

function resourceHref(item: RoutableNotification): string | null {
  const id = item.resourcePublicId?.trim();
  if (!id) return null;
  switch (item.resourceType) {
    case "event":
      return `/e/${encodeURIComponent(id)}`;
    case "group":
      return `/g/${encodeURIComponent(id)}`;
    case "user":
    case "profile":
      return `/u/${encodeURIComponent(id)}`;
    case "registration":
      // Registrations are not addressable on their own; the itinerary is the
      // page that shows a registration's status and its next action.
      return "/me/events";
    case "achievement":
      return "/me/achievements";
    default:
      return null;
  }
}

function typeHref(type: string): string {
  if (type.startsWith("points.")) return "/me/wallet";
  if (type.startsWith("achievements.")) return "/me/achievements";
  if (type.startsWith("safety.") || SAFETY_TYPES.has(type)) return "/safety";
  if (type.startsWith("group.")) return "/groups";
  return "/me/events";
}
