"use client";

import { PreviewModeLink as Link } from "../../../../components/PreviewModeLink";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../../../lib/client-api";
import { StudioNav } from "../../../StudioNav";

interface EventIdentity {
  id: string;
  publicSlug: string;
  title: string;
}

interface PrivateFeedback {
  id: string;
  tags: string[];
  privateSuggestion: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FeedbackSummary {
  published: boolean;
  sampleSize?: number;
  eligibleCount?: number;
  minimumSampleSize?: number;
  tags: Array<{ tag: string; count: number; rate?: number }>;
}

export function HostFeedback({ eventId }: { eventId: string }) {
  const { locale } = useI18n();
  const [event, setEvent] = useState<EventIdentity | null>(null);
  const [items, setItems] = useState<PrivateFeedback[]>([]);
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const copy = hostCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eventValue, privateValue, summaryValue] = await Promise.all([
        apiRequest<EventIdentity>(`/events/${eventId}`, { authenticated: true }),
        apiRequest<{ items: PrivateFeedback[] }>(`/events/${eventId}/feedback/private`, {
          authenticated: true,
        }),
        apiRequest<FeedbackSummary>(`/events/${eventId}/feedback-summary`),
      ]);
      setEvent(eventValue);
      setItems(privateValue.items);
      setSummary(summaryValue);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const sampleSize = summary?.sampleSize ?? summary?.eligibleCount ?? 0;

  return (
    <main className="studio-shell">
      <StudioNav current="events" />
      <section className="studio-content host-feedback-page">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">HOST STUDIO / PRIVATE FEEDBACK</span>
            <h1>{event?.title || copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <div className="row-actions">
            <Link href={`/studio/events/${eventId}/attendees`}>{copy.attendees}</Link>
            {event && <Link href={`/e/${event.publicSlug}`}>{copy.publicPage} ↗</Link>}
          </div>
        </div>

        <aside className="feedback-privacy-note">
          <span aria-hidden="true">◎</span>
          <div>
            <strong>{copy.privacyTitle}</strong>
            <p>{copy.privacyBody}</p>
          </div>
        </aside>

        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{copy.loading}</p>
          </div>
        ) : (
          <>
            <div className="feedback-metrics">
              <article>
                <span>{copy.responses}</span>
                <strong>{sampleSize}</strong>
                <small>{copy.moderated}</small>
              </article>
              <article>
                <span>{copy.publicAggregate}</span>
                <strong>{summary?.published ? copy.published : copy.threshold}</strong>
                <small>
                  {summary?.published
                    ? copy.aggregateLive
                    : copy.aggregatePending.replace(
                        "{count}",
                        String(summary?.minimumSampleSize ?? 5),
                      )}
                </small>
              </article>
              <article>
                <span>{copy.suggestions}</span>
                <strong>{items.filter((item) => item.privateSuggestion).length}</strong>
                <small>{copy.hostOnly}</small>
              </article>
            </div>

            {summary?.published && summary.tags.length > 0 && (
              <section className="host-feedback-summary">
                <span className="section-number">{copy.patterns}</span>
                <div className="feedback-summary-tags">
                  {summary.tags.map((tag) => {
                    const rate = tag.rate ?? (sampleSize ? tag.count / sampleSize : 0);
                    return (
                      <div key={tag.tag}>
                        <span>{tagLabel(tag.tag, locale)}</span>
                        <strong>{Math.round(rate * 100)}%</strong>
                        <i aria-hidden="true">
                          <b style={{ width: `${Math.max(4, Math.min(100, rate * 100))}%` }} />
                        </i>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="private-suggestion-section">
              <div className="section-heading compact-heading">
                <div>
                  <span className="section-number">IMPROVEMENT NOTES</span>
                  <h2>{copy.suggestionTitle}</h2>
                </div>
                <p>{copy.suggestionBody}</p>
              </div>
              {items.some((item) => item.privateSuggestion) ? (
                <div className="private-feedback-list">
                  {items
                    .filter((item) => item.privateSuggestion)
                    .map((item) => (
                      <article key={item.id}>
                        <div className="tag-row">
                          {item.tags.map((tag) => (
                            <span key={tag}>{tagLabel(tag, locale)}</span>
                          ))}
                        </div>
                        <blockquote>{item.privateSuggestion}</blockquote>
                        <time dateTime={item.updatedAt}>
                          {new Intl.DateTimeFormat(
                            locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
                            { dateStyle: "medium" },
                          ).format(new Date(item.updatedAt))}
                        </time>
                      </article>
                    ))}
                </div>
              ) : (
                <div className="empty-state compact-empty">
                  <h2>{copy.empty}</h2>
                  <p>{copy.emptyBody}</p>
                </div>
              )}
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function tagLabel(value: string, locale: "zh-Hans" | "ja" | "en"): string {
  const labels: Record<string, [string, string, string]> = {
    friendly: ["氛围友好", "親しみやすい", "Friendly"],
    well_organized: ["组织周到", "運営が丁寧", "Well organized"],
    clear_information: ["信息清晰", "案内が明确", "Clear information"],
    safe: ["让人安心", "安心できた", "Felt safe"],
    would_join_again: ["愿意再参加", "また参加したい", "Would join again"],
  };
  return labels[value]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? value;
}

function hostCopy(locale: "zh-Hans" | "ja" | "en") {
  if (locale === "ja")
    return {
      title: "参加後のフィードバック",
      body: "個人を特定せず、次回の運営に役立つ傾向と非公開の改善提案を確認できます。",
      attendees: "申込者",
      publicPage: "公開ページ",
      privacyTitle: "信頼を守るフィードバック設計",
      privacyBody: "回答者名や個別評価は表示されません。公開ページには、最低回答数を満たした匿名タグ集計だけが掲載されます。",
      loading: "フィードバックを同期中…",
      responses: "対象回答",
      moderated: "モデレーション済み",
      publicAggregate: "公開集計",
      published: "公開中",
      threshold: "非公開",
      aggregateLive: "匿名集計が公開されています",
      aggregatePending: "{count}件以上で公開されます",
      suggestions: "改善提案",
      hostOnly: "主催者だけに表示",
      patterns: "よかった点の傾向",
      suggestionTitle: "次回に活かすメモ",
      suggestionBody: "報復的な利用や回答者の特定は禁止されています。",
      empty: "非公開の改善提案はまだありません",
      emptyBody: "回答が届くと、個人を特定できない形でここに表示されます。",
    };
  if (locale === "en")
    return {
      title: "Post-event feedback",
      body: "Review privacy-safe patterns and private suggestions that can improve the next gathering.",
      attendees: "Attendees",
      publicPage: "Public page",
      privacyTitle: "Feedback designed for trust",
      privacyBody: "Respondent names and individual ratings are never shown. Only anonymous tag aggregates above the privacy threshold can appear publicly.",
      loading: "Syncing feedback…",
      responses: "Eligible responses",
      moderated: "Moderated",
      publicAggregate: "Public aggregate",
      published: "Live",
      threshold: "Private",
      aggregateLive: "Anonymous aggregate is published",
      aggregatePending: "Publishes after at least {count} responses",
      suggestions: "Suggestions",
      hostOnly: "Visible only to the host",
      patterns: "Positive patterns",
      suggestionTitle: "Notes for the next gathering",
      suggestionBody: "Retaliation and attempts to identify respondents are prohibited.",
      empty: "No private suggestions yet",
      emptyBody: "When attendees share suggestions, they appear here without identifying the respondent.",
    };
  return {
    title: "活动后反馈",
    body: "查看保护参与者隐私的体验趋势和私密改进建议，用于把下一场办得更好。",
    attendees: "报名名单",
    publicPage: "公开页",
    privacyTitle: "为信任而设计的反馈机制",
    privacyBody: "不会显示反馈者姓名或单人评分。只有达到隐私门槛的匿名标签汇总才可能公开。",
    loading: "正在同步反馈…",
    responses: "有效反馈",
    moderated: "已经过内容审核",
    publicAggregate: "公开汇总",
    published: "已发布",
    threshold: "暂不公开",
    aggregateLive: "匿名汇总已在公开页展示",
    aggregatePending: "至少 {count} 份后才会发布",
    suggestions: "改进建议",
    hostOnly: "仅主办方可见",
    patterns: "做得好的方面",
    suggestionTitle: "下一次可以做得更好",
    suggestionBody: "禁止报复或尝试识别反馈者身份。",
    empty: "还没有私密改进建议",
    emptyBody: "参加者提交建议后，会以无法识别个人身份的方式出现在这里。",
  };
}
