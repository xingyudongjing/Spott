import type { EventView } from "./demo-data";

const apiBase =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:4100/v1" : "https://api.spott.jp/v1");

const categoryLabels: Record<string, string> = {
  walk: "城市漫步",
  "city-walk": "城市探索",
  music: "音乐",
  outdoor: "户外",
  art: "创作",
  language: "语言交换",
  food: "美食与咖啡",
  sports: "运动",
  games: "桌游",
  learning: "学习",
  wellness: "身心健康",
  networking: "职业交流",
  volunteering: "志愿活动",
};

export function normalizeEvent(value: Partial<EventView> & Pick<EventView, "id" | "publicSlug" | "title">): EventView {
  const category = value.category ?? value.tags?.[0] ?? "other";
  return {
    id: value.id,
    publicSlug: value.publicSlug,
    title: value.title,
    description: value.description ?? "活动详情正在补充。",
    category,
    categoryLabel: value.categoryLabel ?? categoryLabels[category] ?? "其他",
    startsAt: value.startsAt ?? new Date().toISOString(),
    endsAt: value.endsAt ?? value.startsAt ?? new Date().toISOString(),
    region: value.region ?? "东京",
    publicArea: value.publicArea ?? "地点待定",
    capacity: value.capacity ?? 0,
    confirmedCount: value.confirmedCount ?? 0,
    priceLabel: value.priceLabel ?? "免费",
    status: value.status ?? "published",
    organizer: value.organizer ?? { name: "Spott 用户", handle: "spott", reliability: "手机号已验证" },
    organizerId: value.organizerId,
    groupId: value.groupId ?? null,
    favorited: value.favorited ?? false,
    registrationStatus: value.registrationStatus ?? null,
    version: value.version,
    exactAddress: value.exactAddress ?? null,
    coverURL: value.coverURL ?? null,
    checkinMode: value.checkinMode ?? "dynamic_qr",
    availableActions: value.availableActions ?? [],
    fee: value.fee ?? { isFree: true, boundaryStatement: "本活动免费。" },
    tags: value.tags ?? [category],
    attendeeRequirements: value.attendeeRequirements ?? null,
    registrationQuestions: value.registrationQuestions ?? [],
  };
}

export async function getEvents(): Promise<EventView[]> {
  try {
    const response = await fetch(`${apiBase}/discovery/feed?limit=24`, {
      next: { revalidate: 60, tags: ["events"] },
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { items?: Array<Partial<EventView> & Pick<EventView, "id" | "publicSlug" | "title">> };
    return payload.items?.map(normalizeEvent) ?? [];
  } catch {
    return [];
  }
}

export async function getEvent(slug: string): Promise<EventView | undefined> {
  try {
    const response = await fetch(`${apiBase}/events/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60, tags: [`event:${slug}`] },
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return undefined;
    return normalizeEvent((await response.json()) as Partial<EventView> & Pick<EventView, "id" | "publicSlug" | "title">);
  } catch {
    return undefined;
  }
}
