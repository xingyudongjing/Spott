import Image from "next/image";
import type { EventView } from "../lib/demo-data";
import type { Locale } from "../i18n/messages";

const mark: Record<string, string> = {
  walk: "TOKYO / BLUE HOUR",
  music: "LISTEN / EXCHANGE",
  outdoor: "PACIFIC / 05:45",
  art: "MAKE / PRINT / SHARE",
  language: "LOOK / SPEAK / SLOW",
  food: "TASTE / MAP / CITY",
};

export function EventCover({ event, large = false, locale = "zh-Hans" }: { event: EventView; large?: boolean; locale?: Locale }) {
  const categoryLabel = localizedCategory(event.category, event.categoryLabel, locale);
  if (event.coverURL) {
    return <div className={`event-cover event-cover-photo${large ? " event-cover-large" : ""}`}>
      <Image src={event.coverURL} alt="" fill unoptimized sizes={large ? "(max-width: 780px) 100vw, 60vw" : "(max-width: 780px) 100vw, 33vw"} />
      <span className="event-cover-scrim" />
      <span className="cover-index">SPOTT · {categoryLabel}</span>
      <strong>{event.title}</strong>
    </div>;
  }
  return (
    <div className={`event-cover cover-${event.category}${large ? " event-cover-large" : ""}`}>
      <span className="cover-orbit" />
      <span className="cover-index">SPT / {event.id.slice(-3)}</span>
      <strong>{mark[event.category] ?? "SPOTT / TOKYO"}</strong>
      <span className="cover-category">{categoryLabel}</span>
    </div>
  );
}

function localizedCategory(category: string, fallback: string, locale: Locale) {
  const values: Record<string, [string, string, string]> = {
    walk: ["城市漫步", "まち歩き", "City walks"], "city-walk": ["城市探索", "まち歩き", "City walks"], music: ["音乐", "音楽", "Music"], outdoor: ["户外", "アウトドア", "Outdoors"], art: ["艺术与创作", "アート", "Arts"], language: ["语言交换", "言語交換", "Language"], food: ["美食与咖啡", "フード", "Food"], sports: ["运动", "スポーツ", "Sports"], games: ["桌游", "ゲーム", "Games"], learning: ["学习", "学び", "Learning"], wellness: ["身心健康", "ウェルネス", "Wellness"], networking: ["职业交流", "交流会", "Networking"], volunteering: ["志愿活动", "ボランティア", "Volunteering"],
  };
  const index = locale === "ja" ? 1 : locale === "en" ? 2 : 0;
  return values[category]?.[index] ?? fallback;
}
