import type { Metadata } from "next";
import { PreviewModeLink as Link } from "../components/PreviewModeLink";
import { serverLocale } from "../i18n/server";
import { SafetyCaseTracker } from "./SafetyCaseTracker";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SafetyPage() {
  const locale = await serverLocale();
  const copy =
    locale === "ja"
      ? {
          title: "安心して参加するために。",
          lead: "本人確認、必要な情報だけを見せる設計、記録に残る重要変更、非公開の報告窓口を組み合わせています。",
          emergency: "緊急時",
          emergencyBody:
            "生命・身体に危険がある場合は、Spottへの報告より先に110（警察）または119（救急・消防）へ連絡してください。",
          privacy: "場所のプライバシー",
          privacyBody:
            "正確な集合場所は設定に応じて確定参加者だけに表示し、公開検索やオフラインキャッシュには保存しません。",
          changes: "重要変更",
          changesBody:
            "日時、場所、参加費、参加条件、キャンセルは履歴付きで通知し、再確認または退出を選べます。",
          report: "非公開で報告",
          reportBody:
            "報告者の身元は対象者に表示されません。イベント・グループ・ユーザーのページから報告してください。",
          browse: "イベントを見つける",
        }
      : locale === "en"
        ? {
            title: "Designed for safer gatherings.",
            lead: "Spott combines identity checks, least-privilege location access, auditable critical changes, and private reporting.",
            emergency: "Immediate danger",
            emergencyBody:
              "If anyone is in immediate danger, contact local police or emergency services before filing a Spott report.",
            privacy: "Location privacy",
            privacyBody:
              "Exact meeting points are shown only to eligible confirmed attendees and never stored in public search or offline caches.",
            changes: "Critical changes",
            changesBody:
              "Time, place, fee, eligibility, and cancellations create a recorded notification so attendees can reconfirm or leave.",
            report: "Private reporting",
            reportBody:
              "Your identity is not shown to the reported party. Start a report from the relevant event, group, or profile.",
            browse: "Browse events",
          }
        : {
            title: "让每次见面更安心。",
            lead: "Spott 用身份验证、最小化地址权限、可追溯关键变化和私密举报，共同保护参加者与主办方。",
            emergency: "紧急危险",
            emergencyBody:
              "遇到正在发生的人身危险，请先联系当地警察或急救服务，再补充 Spott 举报记录。",
            privacy: "地址隐私",
            privacyBody:
              "精确集合点只按设置向符合条件的已确认参加者展示，不进入公开搜索或离线缓存。",
            changes: "关键变化",
            changesBody:
              "时间、地点、费用、参加条件和取消都会留下通知记录，参加者可以重新确认或退出。",
            report: "私密举报",
            reportBody:
              "举报者身份不会向被举报方展示。请从对应活动、群组或用户页面发起举报。",
            browse: "发现活动",
          };

  return (
    <main className="safety-page">
      <section className="safety-hero">
        <span className="section-number">TRUST & SAFETY</span>
        <h1>{copy.title}</h1>
        <p>{copy.lead}</p>
      </section>
      <section className="safety-grid">
        <article>
          <span>01</span>
          <h2>{copy.emergency}</h2>
          <p>{copy.emergencyBody}</p>
        </article>
        <article>
          <span>02</span>
          <h2>{copy.privacy}</h2>
          <p>{copy.privacyBody}</p>
        </article>
        <article>
          <span>03</span>
          <h2>{copy.changes}</h2>
          <p>{copy.changesBody}</p>
        </article>
        <article>
          <span>04</span>
          <h2>{copy.report}</h2>
          <p>{copy.reportBody}</p>
        </article>
      </section>
      <SafetyCaseTracker locale={locale} />
      <Link className="primary-action compact" href="/discover">
        {copy.browse}
      </Link>
    </main>
  );
}
