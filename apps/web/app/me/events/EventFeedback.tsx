"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Locale } from "../../i18n/messages";
import { apiRequest, readSession, subscribeSessionChanges } from "../../lib/client-api";
import { isRFC3339DateTime } from "../../lib/rfc3339";
import { StableRequestAttempt } from "../../lib/stable-request-attempt";
import { feedbackCopy, type FeedbackTag } from "./feedback-copy";

type FeedbackVisibility = "aggregate_only" | "private";
type FeedbackSubmissionState =
  | "not_submitted"
  | "edit_available"
  | "edit_limit_reached"
  | "window_closed"
  | "not_eligible";
type FeedbackPhase =
  | "idle"
  | "loading"
  | "load_error"
  | "current"
  | "form"
  | "submitting"
  | "saved_refresh_failed";

interface OwnFeedback {
  id: string;
  attendanceRating: number;
  tags: FeedbackTag[];
  comment: string | null;
  visibility: FeedbackVisibility;
  moderationState: string;
  editCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

interface OwnFeedbackState {
  registrationId: string;
  eventId: string;
  state: FeedbackSubmissionState;
  canSubmit: boolean;
  canEdit: boolean;
  windowClosesAt: string | null;
  feedback: OwnFeedback | null;
}

interface FeedbackReceipt {
  id: string;
  eventId: string;
  status: "pending_moderation";
  rewardPoints: number;
  editCount: number;
  createdAt: string;
}

const tagValues: FeedbackTag[] = [
  "friendly",
  "well_organized",
  "clear_information",
  "safe",
  "would_join_again",
];
const tagSet = new Set<string>(tagValues);
const stateSet = new Set<FeedbackSubmissionState>([
  "not_submitted",
  "edit_available",
  "edit_limit_reached",
  "window_closed",
  "not_eligible",
]);

export function EventFeedback({
  registrationId,
  locale,
}: {
  registrationId: string;
  locale: Locale;
}) {
  return <EventFeedbackScope key={registrationId} registrationId={registrationId} locale={locale} />;
}

function EventFeedbackScope({ registrationId, locale }: { registrationId: string; locale: Locale }) {
  const copy = feedbackCopy(locale);
  const panelId = `event-feedback-${useId().replaceAll(":", "")}`;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<FeedbackPhase>("idle");
  const [authority, setAuthority] = useState<OwnFeedbackState | null>(null);
  const [rating, setRating] = useState(5);
  const [tags, setTags] = useState<FeedbackTag[]>([]);
  const [comment, setComment] = useState("");
  const [visibility, setVisibility] = useState<FeedbackVisibility>("aggregate_only");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const ownerRef = useRef(currentOwnerId());
  const attemptRef = useRef(new StableRequestAttempt());

  const operationIsCurrent = useCallback((generation: number, expectedRegistration: string, ownerId: string) => (
    generationRef.current === generation
    && registrationId === expectedRegistration
    && currentOwnerId() === ownerId
  ), [registrationId]);

  const loadAuthoritative = useCallback(async (
    expectedRegistration: string,
    mode: "regular" | "saved" = "regular",
  ) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    const ownerId = currentOwnerId();
    ownerRef.current = ownerId;
    if (!ownerId) {
      setAuthority(null);
      setPhase(mode === "saved" ? "saved_refresh_failed" : "load_error");
      return;
    }
    if (mode === "regular") {
      setAuthority(null);
      setPhase("loading");
    }
    setMessage("");
    try {
      const raw = await apiRequest<unknown>(`/registrations/${expectedRegistration}/feedback`, {
        method: "GET",
        authenticated: true,
        signal: controller.signal,
      });
      if (!operationIsCurrent(generation, expectedRegistration, ownerId)) return;
      const loaded = parseOwnFeedbackState(raw, expectedRegistration);
      prefill(loaded.feedback, setRating, setTags, setComment, setVisibility);
      setAuthority(loaded);
      setPhase(isConsistentAuthority(loaded) && loaded.state === "not_submitted" ? "form" : "current");
    } catch {
      if (!operationIsCurrent(generation, expectedRegistration, ownerId)) return;
      setAuthority(null);
      setPhase(mode === "saved" ? "saved_refresh_failed" : "load_error");
    }
  }, [operationIsCurrent]);

  useEffect(() => subscribeSessionChanges(() => {
    const nextOwner = currentOwnerId();
    if (nextOwner === ownerRef.current) return;
    ownerRef.current = nextOwner;
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setOpen(false);
    setPhase("idle");
    setAuthority(null);
    setReceipt(null);
    setMessage("");
    setRating(5);
    setTags([]);
    setComment("");
    setVisibility("aggregate_only");
    attemptRef.current.clear();
  }), []);

  useEffect(() => () => {
    generationRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open || phase === "idle" || phase === "loading" || phase === "submitting") return;
    panelRef.current?.focus();
  }, [open, phase]);

  function toggleOpen() {
    if (busyRef.current) return;
    if (open) {
      setOpen(false);
      setPhase("idle");
      queueMicrotask(() => triggerRef.current?.focus());
      return;
    }
    setOpen(true);
    void loadAuthoritative(registrationId);
  }

  function toggleTag(value: FeedbackTag) {
    if (busyRef.current) return;
    setTags((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : current.length < 5
          ? [...current, value]
          : current,
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || phase !== "form" || !authority || !isConsistentAuthority(authority) || !authority.canSubmit) return;
    const expectedRegistration = registrationId;
    const ownerId = currentOwnerId();
    if (!ownerId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    const path = `/registrations/${expectedRegistration}/feedback`;
    const trimmedComment = comment.trim();
    const body = {
      attendanceRating: rating,
      tags,
      ...(trimmedComment ? { comment: trimmedComment } : {}),
      visibility,
    };
    const idempotencyKey = attemptRef.current.keyFor({ method: "POST", path, body });
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    setPhase("submitting");
    let saved = false;
    try {
      const rawReceipt = await apiRequest<unknown>(path, {
        method: "POST",
        authenticated: true,
        idempotencyKey,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!operationIsCurrent(generation, expectedRegistration, ownerId)) return;
      const savedReceipt = parseFeedbackReceipt(rawReceipt, authority.eventId);
      saved = true;
      attemptRef.current.clear();
      setAuthority(null);
      setReceipt(savedReceipt);
      setPhase("loading");

      const rawState = await apiRequest<unknown>(path, {
        method: "GET",
        authenticated: true,
        signal: controller.signal,
      });
      if (!operationIsCurrent(generation, expectedRegistration, ownerId)) return;
      const refreshed = parseOwnFeedbackState(rawState, expectedRegistration);
      prefill(refreshed.feedback, setRating, setTags, setComment, setVisibility);
      setAuthority(refreshed);
      setPhase("current");
    } catch {
      if (!operationIsCurrent(generation, expectedRegistration, ownerId)) return;
      if (saved) {
        setAuthority(null);
        setPhase("saved_refresh_failed");
      } else {
        setPhase("form");
        setMessage(copy.submitError);
      }
    } finally {
      if (operationIsCurrent(generation, expectedRegistration, ownerId)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const authorityIsUsable = authority ? isConsistentAuthority(authority) : false;
  const currentHasFeedback = authorityIsUsable && Boolean(authority?.feedback);

  return (
    <div className="event-feedback">
      <button
        ref={triggerRef}
        className="feedback-trigger"
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={busy}
      >
        {open ? copy.close : copy.open}
      </button>
      {open && (
        <div id={panelId} ref={panelRef} tabIndex={-1}>
          {phase === "loading" && <p role="status">{copy.loading}</p>}
          {phase === "load_error" && (
            <div role="alert">
              <p>{copy.loadError}</p>
              <button type="button" onClick={() => void loadAuthoritative(registrationId)}>{copy.retry}</button>
            </div>
          )}
          {phase === "saved_refresh_failed" && (
            <div className="feedback-confirmation" role="status">
              <strong>{copy.savedRefreshFailed}</strong>
              <button type="button" onClick={() => void loadAuthoritative(registrationId, "saved")}>{copy.retry}</button>
            </div>
          )}
          {phase === "current" && currentHasFeedback && (
            <div className="feedback-confirmation" role="status">
              <strong>{copy.received}</strong>
              <span>
                {receipt && receipt.rewardPoints > 0
                  ? copy.points.replace("{count}", String(receipt.rewardPoints))
                  : copy.review}
              </span>
              {authority?.canEdit && (
                <button type="button" onClick={() => setPhase("form")}>{copy.edit}</button>
              )}
            </div>
          )}
          {phase === "current" && !currentHasFeedback && (
            <p className="feedback-confirmation" role="status">{copy.unavailable}</p>
          )}
          {(phase === "form" || phase === "submitting") && authorityIsUsable && authority?.canSubmit && (
            <form className="feedback-form" onSubmit={(submitEvent) => void submit(submitEvent)}>
              <div className="feedback-heading">
                <div>
                  <span>{copy.privateEyebrow}</span>
                  <strong>{copy.title}</strong>
                </div>
                <small>{copy.privacy}</small>
              </div>
              <fieldset className="rating-picker" disabled={busy}>
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
              <fieldset className="feedback-tags" disabled={busy}>
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
                  onChange={(changeEvent) => setComment(changeEvent.target.value)}
                  maxLength={500}
                  placeholder={copy.placeholder}
                  disabled={busy}
                />
              </label>
              <label className="form-field compact-field">
                {copy.visibility}
                <select
                  value={visibility}
                  onChange={(changeEvent) => setVisibility(changeEvent.target.value as FeedbackVisibility)}
                  disabled={busy}
                >
                  <option value="aggregate_only">{copy.aggregate}</option>
                  <option value="private">{copy.hostOnly}</option>
                </select>
              </label>
              {message && <p className="form-message" role="alert">{message}</p>}
              <button className="primary-action compact" disabled={busy}>
                {busy ? copy.sending : copy.submit}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function currentOwnerId(): string | null {
  return readSession()?.user?.id ?? null;
}

function prefill(
  feedback: OwnFeedback | null,
  setRating: (value: number) => void,
  setTags: (value: FeedbackTag[]) => void,
  setComment: (value: string) => void,
  setVisibility: (value: FeedbackVisibility) => void,
) {
  setRating(feedback?.attendanceRating ?? 5);
  setTags(feedback?.tags ?? []);
  setComment(feedback?.comment ?? "");
  setVisibility(feedback?.visibility ?? "aggregate_only");
}

function parseOwnFeedbackState(value: unknown, expectedRegistration: string): OwnFeedbackState {
  const record = objectRecord(value);
  if (
    record.registrationId !== expectedRegistration
    || !isUUID(record.registrationId)
    || !isUUID(record.eventId)
    || typeof record.state !== "string"
    || !stateSet.has(record.state as FeedbackSubmissionState)
    || typeof record.canSubmit !== "boolean"
    || typeof record.canEdit !== "boolean"
    || !isNullableDate(record.windowClosesAt)
  ) throw new TypeError("Invalid feedback state.");
  return {
    registrationId: record.registrationId,
    eventId: record.eventId,
    state: record.state as FeedbackSubmissionState,
    canSubmit: record.canSubmit,
    canEdit: record.canEdit,
    windowClosesAt: record.windowClosesAt as string | null,
    feedback: record.feedback === null ? null : parseOwnFeedback(record.feedback),
  };
}

function parseOwnFeedback(value: unknown): OwnFeedback {
  const record = objectRecord(value);
  if (
    !isUUID(record.id)
    || !Number.isInteger(record.attendanceRating)
    || (record.attendanceRating as number) < 1
    || (record.attendanceRating as number) > 5
    || !Array.isArray(record.tags)
    || record.tags.length > 5
    || !record.tags.every((tag) => typeof tag === "string" && tagSet.has(tag))
    || !(record.comment === null || typeof record.comment === "string")
    || (typeof record.comment === "string" && record.comment.length > 500)
    || (record.visibility !== "private" && record.visibility !== "aggregate_only")
    || typeof record.moderationState !== "string"
    || !Number.isInteger(record.editCount)
    || (record.editCount as number) < 0
    || !isNullableDate(record.createdAt)
    || !isNullableDate(record.updatedAt)
  ) throw new TypeError("Invalid private feedback.");
  return record as unknown as OwnFeedback;
}

function isConsistentAuthority(value: OwnFeedbackState): boolean {
  if (value.state === "not_submitted") return value.canSubmit && !value.canEdit && value.feedback === null;
  if (value.state === "edit_available") {
    return value.canSubmit && value.canEdit && value.feedback !== null && value.feedback.editCount < 1;
  }
  if (value.state === "edit_limit_reached") {
    return !value.canSubmit && !value.canEdit && value.feedback !== null && value.feedback.editCount >= 1;
  }
  return !value.canSubmit && !value.canEdit;
}

function parseFeedbackReceipt(value: unknown, expectedEventId: string): FeedbackReceipt {
  const record = objectRecord(value);
  if (
    !isUUID(record.id)
    || record.eventId !== expectedEventId
    || record.status !== "pending_moderation"
    || !Number.isInteger(record.editCount)
    || (record.editCount as number) < 0
    || (record.editCount as number) > 1
    || !Number.isInteger(record.rewardPoints)
    || (record.rewardPoints as number) < 0
    || !isDate(record.createdAt)
  ) throw new TypeError("Invalid feedback receipt.");
  return record as unknown as FeedbackReceipt;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object.");
  return value as Record<string, unknown>;
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isDate(value: unknown): value is string {
  return isRFC3339DateTime(value);
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}
