"use client";

import { apiRequest } from "./client-api";
import { parseEventDetail, type EventDetail } from "./event-contract";

export async function fetchViewerEvent(
  identifier: string,
  options?: { signal?: AbortSignal },
): Promise<EventDetail> {
  const init: RequestInit & { authenticated: true } = { authenticated: true };
  if (options?.signal) init.signal = options.signal;
  const payload = await apiRequest<unknown>(
    `/events/${encodeURIComponent(identifier)}`,
    init,
  );
  return parseEventDetail(payload);
}
