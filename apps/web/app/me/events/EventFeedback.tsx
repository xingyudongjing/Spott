"use client";

import { useState } from "react";
import type { Locale } from "../../i18n/messages";
import { apiRequest, errorMessage } from "../../lib/client-api";
import { feedbackCopy, type FeedbackTag } from "./feedback-copy";

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
                <span>{copy.tagsByValue[value]}</span>
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
