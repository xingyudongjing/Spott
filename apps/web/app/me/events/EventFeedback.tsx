"use client";

import { useState } from "react";
import type { Locale } from "../../i18n/messages";
import { apiRequest, errorMessage } from "../../lib/client-api";

type FeedbackTag =
  | "friendly"
  | "well_organized"
  | "clear_information"
  | "safe"
  | "would_join_again";

interface FeedbackResult {
  status: string;
  rewardPoints: number;
  editCount: number;
}

const tagValues: FeedbackTag[] = [
  "friendly",
  "well_organized",
  "clear_information",
  "safe",
  "would_join_again",
];

export function EventFeedback({
  registrationId,
  locale,
}: {
  registrationId: string;
  locale: Locale;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [tags, setTags] = useState<FeedbackTag[]>([]);
  const [comment, setComment] = useState("");
  const [visibility, setVisibility] = useState<"aggregate_only" | "private">("aggregate_only");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<FeedbackResult | null>(null);
  const copy = feedbackCopy(locale);

  function toggleTag(value: FeedbackTag) {
    setTags((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : current.length < 5
          ? [...current, value]
          : current,
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const value = await apiRequest<FeedbackResult>(`/registrations/${registrationId}/feedback`, {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({
          attendanceRating: rating,
          tags,
          comment: comment.trim() || undefined,
          visibility,
        }),
      });
      setResult(value);
      setOpen(false);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="feedback-confirmation" role="status">
        <strong>{copy.received}</strong>
        <span>
          {result.rewardPoints > 0
            ? copy.points.replace("{count}", String(result.rewardPoints))
            : copy.review}
        </span>
        {result.editCount < 1 && (
          <button type="button" onClick={() => setResult(null)}>
            {copy.edit}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="event-feedback">
      <button className="feedback-trigger" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? copy.close : copy.open}
      </button>
      {open && (
        <form className="feedback-form" onSubmit={(event) => void submit(event)}>
          <div className="feedback-heading">
            <div>
              <span>{copy.privateEyebrow}</span>
              <strong>{copy.title}</strong>
            </div>
            <small>{copy.privacy}</small>
          </div>
          <fieldset className="rating-picker">
            <legend>{copy.rating}</legend>
            {[1, 2, 3, 4, 5].map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`rating-${registrationId}`}
                  value={value}
                  checked={rating === value}
                  onChange={() => setRating(value)}
                />
                <span>{value}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="feedback-tags">
            <legend>{copy.tags}</legend>
            {tagValues.map((value) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={tags.includes(value)}
                  onChange={() => toggleTag(value)}
                />
                <span>{tagLabel(value, locale)}</span>
              </label>
            ))}
          </fieldset>
          <label className="form-field">
            {copy.comment}
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={500}
              placeholder={copy.placeholder}
            />
          </label>
          <label className="form-field compact-field">
            {copy.visibility}
            <select
              value={visibility}
              onChange={(event) =>
                setVisibility(event.target.value as "aggregate_only" | "private")
              }
            >
              <option value="aggregate_only">{copy.aggregate}</option>
              <option value="private">{copy.hostOnly}</option>
            </select>
          </label>
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          <button className="primary-action compact" disabled={busy}>
            {busy ? copy.sending : copy.submit}
          </button>
        </form>
      )}
    </div>
  );
}

function tagLabel(tag: FeedbackTag, locale: Locale): string {
  const labels: Record<FeedbackTag, [string, string, string]> = {
    friendly: ["氛围友好", "親しみやすい", "Friendly"],
    well_organized: ["组织周到", "運営が丁寧", "Well organized"],
    clear_information: ["信息清晰", "案内が明確", "Clear information"],
    safe: ["让人安心", "安心できた", "Felt safe"],
    would_join_again: ["愿意再参加", "また参加したい", "Would join again"],
  };
  return labels[tag][locale === "ja" ? 1 : locale === "en" ? 2 : 0];
}

function feedbackCopy(locale: Locale) {
  if (locale === "ja")
    return {
      open: "参加後のフィードバック",
      close: "フィードバックを閉じる",
      privateEyebrow: "POST-EVENT / PRIVATE",
      title: "体験を振り返る",
      privacy: "回答は公開プロフィールに表示されません",
      rating: "総合評価",
      tags: "当てはまるもの",
      comment: "主催者への改善提案（任意）",
      placeholder: "次回がもっと良くなる具体的な提案を入力してください",
      visibility: "コメントの共有範囲",
      aggregate: "匿名集計にのみ利用",
      hostOnly: "主催者に非公開フィードバックとして共有",
      sending: "送信中…",
      submit: "フィードバックを送信",
      received: "フィードバックを受け付けました",
      points: "{count}ポイントを付与しました",
      review: "公開集計前にモデレーションされます",
      edit: "1回だけ編集",
    };
  if (locale === "en")
    return {
      open: "Post-event feedback",
      close: "Close feedback",
      privateEyebrow: "POST-EVENT / PRIVATE",
      title: "Reflect on the experience",
      privacy: "Your response never appears on your public profile",
      rating: "Overall rating",
      tags: "What went well",
      comment: "Private suggestion for the host (optional)",
      placeholder: "Share one concrete idea that could make the next gathering better",
      visibility: "Comment visibility",
      aggregate: "Use only in anonymous aggregates",
      hostOnly: "Share privately with the host",
      sending: "Sending…",
      submit: "Send feedback",
      received: "Feedback received",
      points: "You earned {count} points",
      review: "It will be moderated before any aggregate is published",
      edit: "Edit once",
    };
  return {
    open: "活动后反馈",
    close: "收起反馈",
    privateEyebrow: "POST-EVENT / PRIVATE",
    title: "回顾这次体验",
    privacy: "回答不会出现在你的公开主页",
    rating: "总体评价",
    tags: "哪些方面做得好",
    comment: "给主办方的私密改进建议（选填）",
    placeholder: "写一条具体建议，让下一次见面更好",
    visibility: "建议的使用方式",
    aggregate: "只用于匿名汇总",
    hostOnly: "作为私密反馈提供给主办方",
    sending: "正在提交…",
    submit: "提交反馈",
    received: "反馈已收到",
    points: "已获得 {count} 积分",
    review: "内容审核通过后才会进入匿名汇总",
    edit: "可再修改一次",
  };
}
