export const locales = ["zh-Hans", "ja", "en"] as const;
export type Locale = (typeof locales)[number];

export const localeNames: Record<Locale, string> = {
  "zh-Hans": "简体中文",
  ja: "日本語",
  en: "English",
};

const zh = {
  "nav.discover": "发现",
  "nav.groups": "群组",
  "nav.myEvents": "我的活动",
  "nav.hostStudio": "主办方工作台",
  "nav.search": "搜索活动",
  "nav.notifications": "通知",
  "nav.create": "创建活动",
  "nav.login": "登录",
  "nav.account": "我的账户",
  "common.loading": "正在加载…",
  "common.retry": "重试",
  "common.clear": "清除筛选",
  "common.open": "打开",
  "common.free": "免费",
  "common.more": "加载更多",
  "common.people": "人",
  "discover.eyebrow": "日本 · 精选同城活动",
  "discover.kicker": "附近有什么值得参加？",
  "discover.title": "找到兴趣相投的人，\n一起认真做点有趣的事。",
  "discover.note": "真实主办方、清楚规则，\n报名状态在 Web 与 iOS 同步。",
  "discover.searchPlaceholder": "搜索活动、地点、主办方或兴趣",
  "discover.category": "分类",
  "discover.region": "地区",
  "discover.when": "时间",
  "discover.availability": "只看有名额",
  "discover.all": "全部",
  "discover.anytime": "任何时间",
  "discover.today": "今天",
  "discover.weekend": "本周末",
  "discover.nextWeek": "未来 7 天",
  "discover.results": "为你找到的活动",
  "discover.resultCount": "{count} 个活动 · 按日本时间",
  "discover.emptyTitle": "暂时没有符合条件的活动",
  "discover.emptyBody": "换个关键词、地区或时间试试看。",
  "discover.error": "活动没有加载成功，请检查网络后重试。",
  "discover.hostTitle": "还没找到想参加的活动？",
  "discover.hostBody": "用六个清晰步骤发布活动，报名、候补、签到与通知会在 Web 和 iOS 同步。",
  "discover.hostCta": "发起活动",
  "event.spots": "余 {count}",
  "event.waitlist": "候补中",
  "event.register": "报名参加",
  "event.joinWaitlist": "加入候补",
  "event.viewRegistration": "查看我的报名",
  "event.favorite": "收藏活动",
  "event.favorited": "已收藏",
  "event.share": "分享",
  "event.calendar": "加入日历",
  "event.followHost": "关注主办方",
  "event.loginToFavorite": "登录后收藏",
  "registration.title": "确认参加信息",
  "registration.waitlistTitle": "加入候补",
  "registration.questions": "主办方的问题",
  "registration.required": "必填",
  "registration.note": "想对主办方补充什么？",
  "registration.notePlaceholder": "可选，例如饮食、装备或到达情况",
  "registration.submit": "确认并报名",
  "registration.submitWaitlist": "确认加入候补",
  "registration.submitting": "正在确认…",
  "registration.acceptFee": "我已阅读线下费用与退款边界",
  "registration.success": "报名完成",
  "registration.waitlistSuccess": "已加入候补",
  "group.directory": "兴趣群组",
  "group.directoryBody": "在 Web 和 iOS 加入同一个群组，接收公告、讨论后续活动。",
  "group.myGroups": "我的群组",
  "group.create": "创建群组",
  "group.join": "加入群组",
  "group.joined": "已加入",
  "group.pending": "等待审核",
  "group.members": "{count} 位成员",
  "group.capacity": "上限 {count} 人",
  "group.events": "群组活动",
  "group.announcements": "公告与讨论",
  "group.noAnnouncements": "还没有公告。主办方发布后会同步到 Web 与 iOS。",
  "group.empty": "你还没有加入群组",
  "group.emptyBody": "从活动主办方主页或群组链接加入后，会出现在这里。",
  "footer.tagline": "发现活动，遇见同好。",
  "footer.safety": "安全中心",
  "footer.privacy": "隐私",
  "footer.terms": "条款",
  "footer.offline": "离线说明",
} as const;

type MessageKey = keyof typeof zh;

const ja: Record<MessageKey, string> = {
  "nav.discover": "見つける", "nav.groups": "グループ", "nav.myEvents": "参加予定", "nav.hostStudio": "主催者スタジオ", "nav.search": "イベントを検索", "nav.notifications": "お知らせ", "nav.create": "イベント作成", "nav.login": "ログイン", "nav.account": "アカウント",
  "common.loading": "読み込み中…", "common.retry": "もう一度", "common.clear": "条件をリセット", "common.open": "開く", "common.free": "無料", "common.more": "さらに表示", "common.people": "人",
  "discover.eyebrow": "日本 · 厳選ローカルイベント", "discover.kicker": "近くで、何か面白いことは？", "discover.title": "同じ興味を持つ人と、\n好きなことを一緒に。", "discover.note": "信頼できる主催者と明確なルール。\nWeb と iOS で申込状況を同期します。", "discover.searchPlaceholder": "イベント、場所、主催者、興味で検索", "discover.category": "カテゴリー", "discover.region": "エリア", "discover.when": "日時", "discover.availability": "空席ありのみ", "discover.all": "すべて", "discover.anytime": "いつでも", "discover.today": "今日", "discover.weekend": "今週末", "discover.nextWeek": "7日以内", "discover.results": "おすすめイベント", "discover.resultCount": "{count}件 · 日本時間", "discover.emptyTitle": "条件に合うイベントがありません", "discover.emptyBody": "キーワード、エリア、日時を変えてみてください。", "discover.error": "イベントを読み込めませんでした。通信を確認してもう一度お試しください。", "discover.hostTitle": "参加したいイベントが見つからない？", "discover.hostBody": "6つのステップで公開。申込、ウェイトリスト、チェックイン、お知らせは Web と iOS で同期します。", "discover.hostCta": "イベントを作る",
  "event.spots": "残り {count}", "event.waitlist": "キャンセル待ち", "event.register": "参加申し込み", "event.joinWaitlist": "キャンセル待ちに登録", "event.viewRegistration": "申込を確認", "event.favorite": "保存", "event.favorited": "保存済み", "event.share": "シェア", "event.calendar": "カレンダーに追加", "event.followHost": "主催者をフォロー", "event.loginToFavorite": "ログインして保存",
  "registration.title": "参加内容を確認", "registration.waitlistTitle": "キャンセル待ちに登録", "registration.questions": "主催者からの質問", "registration.required": "必須", "registration.note": "主催者への補足", "registration.notePlaceholder": "任意：食事、持ち物、到着時刻など", "registration.submit": "申し込みを確定", "registration.submitWaitlist": "キャンセル待ちを確定", "registration.submitting": "確認中…", "registration.acceptFee": "参加費と返金条件を確認しました", "registration.success": "申し込み完了", "registration.waitlistSuccess": "キャンセル待ちに登録しました",
  "group.directory": "興味でつながるグループ", "group.directoryBody": "Web と iOS で同じグループに参加し、お知らせや次のイベントを確認できます。", "group.myGroups": "参加中のグループ", "group.create": "グループを作成", "group.join": "グループに参加", "group.joined": "参加済み", "group.pending": "承認待ち", "group.members": "メンバー {count}人", "group.capacity": "定員 {count}人", "group.events": "グループのイベント", "group.announcements": "お知らせとディスカッション", "group.noAnnouncements": "お知らせはまだありません。投稿されると Web と iOS に同期されます。", "group.empty": "参加中のグループはありません", "group.emptyBody": "イベントや招待リンクから参加すると、ここに表示されます。",
  "footer.tagline": "イベントを見つけ、仲間と出会う。", "footer.safety": "安全センター", "footer.privacy": "プライバシー", "footer.terms": "利用規約", "footer.offline": "オフラインについて",
};

const en: Record<MessageKey, string> = {
  "nav.discover": "Discover", "nav.groups": "Groups", "nav.myEvents": "My events", "nav.hostStudio": "Host studio", "nav.search": "Search events", "nav.notifications": "Notifications", "nav.create": "Create event", "nav.login": "Log in", "nav.account": "My account",
  "common.loading": "Loading…", "common.retry": "Try again", "common.clear": "Clear filters", "common.open": "Open", "common.free": "Free", "common.more": "Load more", "common.people": "people",
  "discover.eyebrow": "Japan · Curated local events", "discover.kicker": "What is worth joining nearby?", "discover.title": "Meet people who share your interests,\nand do something memorable together.", "discover.note": "Real hosts and clear expectations.\nYour status stays in sync across Web and iOS.", "discover.searchPlaceholder": "Search events, places, hosts, or interests", "discover.category": "Category", "discover.region": "Area", "discover.when": "When", "discover.availability": "Available spots only", "discover.all": "All", "discover.anytime": "Any time", "discover.today": "Today", "discover.weekend": "This weekend", "discover.nextWeek": "Next 7 days", "discover.results": "Events for you", "discover.resultCount": "{count} events · Japan time", "discover.emptyTitle": "No events match these filters yet", "discover.emptyBody": "Try another keyword, area, or date.", "discover.error": "Events could not be loaded. Check your connection and try again.", "discover.hostTitle": "Can’t find the event you want?", "discover.hostBody": "Publish in six clear steps. Registration, waitlists, check-in, and notifications sync across Web and iOS.", "discover.hostCta": "Host an event",
  "event.spots": "{count} left", "event.waitlist": "Waitlist", "event.register": "Register", "event.joinWaitlist": "Join waitlist", "event.viewRegistration": "View registration", "event.favorite": "Save event", "event.favorited": "Saved", "event.share": "Share", "event.calendar": "Add to calendar", "event.followHost": "Follow host", "event.loginToFavorite": "Log in to save",
  "registration.title": "Confirm your registration", "registration.waitlistTitle": "Join the waitlist", "registration.questions": "Questions from the host", "registration.required": "Required", "registration.note": "Anything else for the host?", "registration.notePlaceholder": "Optional: dietary needs, equipment, or arrival details", "registration.submit": "Confirm registration", "registration.submitWaitlist": "Confirm waitlist", "registration.submitting": "Confirming…", "registration.acceptFee": "I have read the offline fee and refund terms", "registration.success": "You’re registered", "registration.waitlistSuccess": "You’re on the waitlist",
  "group.directory": "Interest groups", "group.directoryBody": "Join the same group on Web and iOS for announcements, discussions, and what’s next.", "group.myGroups": "My groups", "group.create": "Create group", "group.join": "Join group", "group.joined": "Joined", "group.pending": "Approval pending", "group.members": "{count} members", "group.capacity": "Capacity {count}", "group.events": "Group events", "group.announcements": "Announcements & discussion", "group.noAnnouncements": "No announcements yet. New posts will sync across Web and iOS.", "group.empty": "You haven’t joined a group yet", "group.emptyBody": "Groups you join from an event or invite link will appear here.",
  "footer.tagline": "Find events. Meet your people.", "footer.safety": "Safety", "footer.privacy": "Privacy", "footer.terms": "Terms", "footer.offline": "Offline use",
};

export const messages: Record<Locale, Record<MessageKey, string>> = { "zh-Hans": zh, ja, en };

export function isLocale(value: string | null | undefined): value is Locale {
  return locales.includes(value as Locale);
}

export function formatMessage(locale: Locale, key: MessageKey, values?: Record<string, string | number>): string {
  let value = messages[locale][key] ?? messages["zh-Hans"][key];
  for (const [name, replacement] of Object.entries(values ?? {})) value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
}

export type { MessageKey };
