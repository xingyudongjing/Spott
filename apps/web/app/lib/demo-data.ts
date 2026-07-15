export type EventStatus = "draft" | "submitted" | "under_review" | "published" | "registration_closed" | "in_progress" | "cancelled" | "ended" | "removed";

export interface EventView {
  id: string;
  publicSlug: string;
  title: string;
  description: string;
  category: string;
  categoryLabel: string;
  startsAt: string;
  endsAt: string;
  region: string;
  publicArea: string;
  capacity: number;
  confirmedCount: number;
  priceLabel: string;
  status: EventStatus;
  organizer: { id?: string; name: string; handle: string; reliability: string; viewerFollowing?: boolean };
  organizerId?: string;
  groupId?: string | null;
  favorited?: boolean;
  registrationStatus?: string | null;
  version?: number;
  exactAddress?: string | null;
  coverURL?: string | null;
  checkinMode?: "dynamic_qr" | "six_digit" | "manual";
  availableActions: string[];
  fee: {
    isFree: boolean;
    amountJPY?: number;
    collectorName?: string;
    method?: string;
    refundPolicy?: string;
    boundaryStatement: string;
  };
  tags: string[];
  attendeeRequirements?: string | null;
  registrationQuestions?: Array<{
    id?: string;
    prompt: string;
    kind: "text" | "single_choice" | "boolean";
    required: boolean;
    options: string[];
  }>;
}

export const events: EventView[] = [
  {
    id: "019b0000-0000-7000-8100-000000000001",
    publicSlug: "tokyo-afterglow-walk",
    title: "东京余光 · 隅田川蓝调散步",
    description:
      "从清澄白河走到隅田川，在入夜前后记录城市颜色。沿途会经过旧仓库、桥下空间和一段很安静的河岸，适合第一次参加的朋友。",
    category: "walk",
    categoryLabel: "城市漫步",
    startsAt: "2026-07-18T08:30:00Z",
    endsAt: "2026-07-18T11:00:00Z",
    region: "东京",
    publicArea: "清澄白河站附近",
    capacity: 24,
    confirmedCount: 11,
    priceLabel: "免费",
    status: "published",
    organizer: { name: "周末开局", handle: "weekend_kai", reliability: "连续完成 18 场" },
    availableActions: ["register"],
    fee: { isFree: true, boundaryStatement: "本活动免费。" },
    tags: ["散步", "摄影", "初次友好"],
  },
  {
    id: "019b0000-0000-7000-8100-000000000002",
    publicSlug: "shimokita-vinyl-night",
    title: "下北泽黑胶交换夜",
    description: "带一张最近循环播放的唱片，认识同样认真听歌的人。",
    category: "music",
    categoryLabel: "音乐",
    startsAt: "2026-07-20T10:00:00Z",
    endsAt: "2026-07-20T13:00:00Z",
    region: "东京",
    publicArea: "下北泽",
    capacity: 16,
    confirmedCount: 8,
    priceLabel: "免费",
    status: "published",
    organizer: { name: "小光", handle: "tokyo_hikari", reliability: "到场率 90%–95%" },
    availableActions: ["register"],
    fee: { isFree: true, boundaryStatement: "本活动免费。" },
    tags: ["黑胶", "音乐", "小型聚会"],
  },
  {
    id: "019b0000-0000-7000-8100-000000000003",
    publicSlug: "kamakura-morning-surf",
    title: "镰仓晨光冲浪体验",
    description: "零基础小班，装备由外部教练提供。先在沙滩完成安全说明，再按海况分组下水。",
    category: "outdoor",
    categoryLabel: "户外",
    startsAt: "2026-07-25T21:00:00Z",
    endsAt: "2026-07-26T00:00:00Z",
    region: "神奈川",
    publicArea: "镰仓海岸",
    capacity: 10,
    confirmedCount: 9,
    priceLabel: "¥4,500",
    status: "published",
    organizer: { name: "周末开局", handle: "weekend_kai", reliability: "已完成身份验证" },
    availableActions: ["register"],
    fee: {
      isFree: false,
      amountJPY: 4500,
      collectorName: "Wave Studio",
      method: "现场 PayPay",
      refundPolicy: "活动开始 48 小时前可联系组织者退款",
      boundaryStatement: "费用由组织者自行收取，Spott 不经手活动款。",
    },
    tags: ["冲浪", "新手", "清晨"],
  },
  {
    id: "019b0000-0000-7000-8100-000000000004",
    publicSlug: "koenji-zine-table",
    title: "高圆寺 Zine 小桌会",
    description: "把还没做完的小册子也带来。我们聊印刷、装订和怎么把一个念头做出来。",
    category: "art",
    categoryLabel: "创作",
    startsAt: "2026-07-26T05:00:00Z",
    endsAt: "2026-07-26T08:00:00Z",
    region: "东京",
    publicArea: "高圆寺",
    capacity: 12,
    confirmedCount: 6,
    priceLabel: "¥800",
    status: "published",
    organizer: { name: "纸边俱乐部", handle: "paper_edge", reliability: "连续完成 9 场" },
    availableActions: ["register"],
    fee: {
      isFree: false,
      amountJPY: 800,
      collectorName: "纸边俱乐部",
      method: "现场现金",
      refundPolicy: "材料准备后不退款，可转让名额",
      boundaryStatement: "费用由组织者自行收取，Spott 不经手活动款。",
    },
    tags: ["Zine", "手作", "交流"],
  },
  {
    id: "019b0000-0000-7000-8100-000000000005",
    publicSlug: "ueno-museum-japanese",
    title: "上野美术馆 · 日语慢聊",
    description: "看一场展，再找个安静的地方用简单日语分享最喜欢的一件作品。",
    category: "language",
    categoryLabel: "语言",
    startsAt: "2026-07-27T04:00:00Z",
    endsAt: "2026-07-27T07:00:00Z",
    region: "东京",
    publicArea: "上野公园",
    capacity: 8,
    confirmedCount: 8,
    priceLabel: "各自购票",
    status: "published",
    organizer: { name: "东京慢速会", handle: "slow_tokyo", reliability: "到场率 85%–90%" },
    availableActions: ["joinWaitlist"],
    fee: {
      isFree: false,
      collectorName: "美术馆",
      method: "各自购票",
      refundPolicy: "按美术馆票务规则",
      boundaryStatement: "门票由参加者自行购买，Spott 不经手活动款。",
    },
    tags: ["日语", "美术馆", "小组"],
  },
  {
    id: "019b0000-0000-7000-8100-000000000006",
    publicSlug: "kichijoji-coffee-map",
    title: "吉祥寺咖啡地图共创",
    description: "四人一组走访街角咖啡店，把气味、座位和最适合去的时刻做成地图。",
    category: "food",
    categoryLabel: "咖啡",
    startsAt: "2026-08-01T02:00:00Z",
    endsAt: "2026-08-01T06:00:00Z",
    region: "东京",
    publicArea: "吉祥寺",
    capacity: 20,
    confirmedCount: 7,
    priceLabel: "各自消费",
    status: "published",
    organizer: { name: "城市味觉", handle: "city_palate", reliability: "新局头 · 已验证" },
    availableActions: ["register"],
    fee: {
      isFree: false,
      collectorName: "各店铺",
      method: "各自消费",
      refundPolicy: "无统一收费",
      boundaryStatement: "消费由参加者直接支付给店铺，Spott 不经手活动款。",
    },
    tags: ["咖啡", "地图", "共创"],
  },
];

export const categories = [
  ["all", "全部"],
  ["walk", "散步"],
  ["music", "音乐"],
  ["outdoor", "户外"],
  ["art", "创作"],
  ["language", "语言"],
  ["food", "咖啡"],
] as const;

export function findEvent(slug: string): EventView | undefined {
  return events.find((event) => event.publicSlug === slug || event.id === slug);
}
