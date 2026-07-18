import type { Locale } from "../i18n/messages";

const tagLabels = {
  family: { "zh-Hans": "亲子", ja: "親子", en: "Family" },
  outdoors: { "zh-Hans": "户外", ja: "アウトドア", en: "Outdoors" },
  sports: { "zh-Hans": "运动", ja: "スポーツ", en: "Sports" },
  cityWalk: { "zh-Hans": "城市探索", ja: "まち歩き", en: "City walks" },
  photography: { "zh-Hans": "摄影", ja: "写真", en: "Photography" },
  firstTimer: { "zh-Hans": "初次参加友好", ja: "初参加歓迎", en: "First-timer friendly" },
  music: { "zh-Hans": "音乐", ja: "音楽", en: "Music" },
  vinyl: { "zh-Hans": "黑胶", ja: "レコード", en: "Vinyl" },
  smallGroup: { "zh-Hans": "小规模", ja: "少人数", en: "Small group" },
  coast: { "zh-Hans": "海岸", ja: "海岸", en: "Coast" },
  morning: { "zh-Hans": "清晨", ja: "朝", en: "Morning" },
  easyPace: { "zh-Hans": "轻松节奏", ja: "ゆったり", en: "Easy pace" },
  food: { "zh-Hans": "美食", ja: "フード・カフェ", en: "Food & coffee" },
  art: { "zh-Hans": "文化艺术", ja: "アート・ものづくり", en: "Arts & making" },
  language: { "zh-Hans": "语言交换", ja: "言語交換", en: "Language exchange" },
  games: { "zh-Hans": "游戏", ja: "ゲーム", en: "Games" },
  learning: { "zh-Hans": "技能学习", ja: "学び", en: "Learning" },
  wellness: { "zh-Hans": "身心健康", ja: "ウェルネス", en: "Wellness" },
  networking: { "zh-Hans": "职业交流", ja: "交流会", en: "Networking" },
} as const satisfies Record<string, Record<Locale, string>>;

type PublicTag = keyof typeof tagLabels;

const tagAliases: Record<string, PublicTag> = {
  family: "family", "亲子": "family", "親子": "family",
  outdoor: "outdoors", outdoors: "outdoors", "户外": "outdoors", "戶外": "outdoors", "アウトドア": "outdoors",
  sports: "sports", "运动": "sports", "運動": "sports", "スポーツ": "sports",
  walk: "cityWalk", "city-walk": "cityWalk", "city walk": "cityWalk", "城市散步": "cityWalk", "城市漫步": "cityWalk", "街歩き": "cityWalk",
  photography: "photography", "摄影": "photography", "攝影": "photography", "写真": "photography",
  "first-timer-friendly": "firstTimer", "first timer friendly": "firstTimer", "初次友好": "firstTimer", "初次参加友好": "firstTimer", "初参加歓迎": "firstTimer",
  music: "music", "音乐": "music", "音樂": "music", "音楽": "music",
  vinyl: "vinyl", record: "vinyl", "黑胶": "vinyl", "黑膠": "vinyl", "レコード": "vinyl",
  "small-group": "smallGroup", "small group": "smallGroup", "小规模": "smallGroup", "小規模": "smallGroup", "少人数": "smallGroup",
  coast: "coast", "海岸": "coast",
  morning: "morning", "清晨": "morning", "朝": "morning",
  "easy-pace": "easyPace", "easy pace": "easyPace", "轻松节奏": "easyPace", "輕鬆節奏": "easyPace", "ゆったり": "easyPace",
  food: "food", coffee: "food", "美食": "food", "咖啡": "food", "フード": "food", "コーヒー": "food",
  art: "art", culture: "art", "文化艺术": "art", "文化藝術": "art", "アート": "art",
  language: "language", "language-exchange": "language", "语言交换": "language", "語言交換": "language", "言語交換": "language",
  games: "games", "游戏": "games", "遊戲": "games", "ゲーム": "games",
  learning: "learning", "技能学习": "learning", "技能學習": "learning", "学び": "learning",
  wellness: "wellness", "身心健康": "wellness", "ウェルネス": "wellness",
  networking: "networking", "职业交流": "networking", "職業交流": "networking", "交流会": "networking",
};

function normalizedTag(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function localizedPublicTags(
  values: readonly string[],
  locale: Locale,
  limit = Number.POSITIVE_INFINITY,
) {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizedTag(value);
    if (!normalized) continue;
    const semanticTag = tagAliases[normalized];
    const label = semanticTag ? tagLabels[semanticTag][locale] : value.trim();
    const identity = normalizedTag(label);
    if (seen.has(identity)) continue;
    seen.add(identity);
    labels.push(label);
    if (labels.length >= limit) break;
  }

  return labels;
}
