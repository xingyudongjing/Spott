"use client";

import { useEffect, useState } from "react";
import type { Locale } from "../../i18n/messages";
import { apiRequest } from "../../lib/client-api";

interface FeedbackSummary {
  eventId?: string;
  sampleSize?: number;
  eligibleCount?: number;
  minimumSampleSize?: number;
  published: boolean;
  tags: Array<{ tag: string; count: number; rate?: number }>;
}

export function EventFeedbackSummary({ eventId, locale }: { eventId: string; locale: Locale }) {
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);

  useEffect(() => {
    let active = true;
    void apiRequest<FeedbackSummary>(`/events/${eventId}/feedback-summary`)
      .then((value) => {
        if (active) setSummary(value);
      })
      .catch(() => {
        if (active) setSummary(null);
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  if (!summary?.published || !summary.tags.length) return null;
  const count = summary.sampleSize ?? summary.eligibleCount ?? 0;
  const copy =
    locale === "ja"
      ? {
          eyebrow: "参加者からのフィードバック",
          title: "参加後の声",
          sample: `${count}件のモデレーション済み回答を匿名で集計`,
          privacy: "個別の回答や参加者の身元は公開されません。",
        }
      : locale === "en"
        ? {
            eyebrow: "ATTENDEE FEEDBACK",
            title: "After the gathering",
            sample: `Anonymous aggregate from ${count} moderated responses`,
            privacy: "Individual responses and attendee identities are never public.",
          }
        : {
            eyebrow: "参加者反馈",
            title: "见面之后，他们这样评价",
            sample: `${count} 份审核通过的匿名反馈汇总`,
            privacy: "不会公开单条反馈或参加者身份。",
          };

  return (
    <section className="public-feedback-summary">
      <span className="section-number">{copy.eyebrow}</span>
      <div className="public-feedback-heading">
        <h2>{copy.title}</h2>
        <p>{copy.sample}</p>
      </div>
      <div className="feedback-summary-tags">
        {summary.tags.map((item) => {
          const rate = item.rate ?? (count > 0 ? item.count / count : 0);
          return (
            <div key={item.tag}>
              <span>{feedbackTag(item.tag, locale)}</span>
              <strong>{Math.round(rate * 100)}%</strong>
              <i aria-hidden="true">
                <b style={{ width: `${Math.max(4, Math.min(100, rate * 100))}%` }} />
              </i>
            </div>
          );
        })}
      </div>
      <small>{copy.privacy}</small>
    </section>
  );
}

function feedbackTag(value: string, locale: Locale): string {
  const labels: Record<string, [string, string, string]> = {
    friendly: ["氛围友好", "親しみやすい", "Friendly"],
    well_organized: ["组织周到", "運営が丁寧", "Well organized"],
    clear_information: ["信息清晰", "案内が明確", "Clear information"],
    safe: ["让人安心", "安心できた", "Felt safe"],
    would_join_again: ["愿意再参加", "また参加したい", "Would join again"],
  };
  return labels[value]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? value;
}
