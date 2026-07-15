import Link from "next/link";
import { serverLocale } from "../i18n/server";

export default async function Offline() {
  const locale = await serverLocale();
  const copy = locale === "ja" ? ["オフラインです", "キャッシュ済みの公開イベントは確認できます。正確な場所、チェックインコード、ポイント操作には再接続が必要です。", "キャッシュを見る"] : locale === "en" ? ["You’re offline", "Cached public events remain available. Exact locations, check-in codes, and point actions require a connection.", "View cached events"] : ["暂时离线", "已缓存的公开活动仍可查看；精确地址、动态签到码和积分操作需要重新联网。", "查看缓存活动"];
  return <main className="flow-page"><div className="empty-state"><span className="spotlight-empty" /><h1>{copy[0]}</h1><p>{copy[1]}</p><Link className="primary-action compact" href="/discover">{copy[2]}</Link></div></main>;
}
