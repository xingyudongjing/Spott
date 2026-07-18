"use client";

import { PreviewModeLink as Link } from "../../components/PreviewModeLink";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useAppDialog } from "../../components/AppDialog";
import type { Locale } from "../../i18n/messages";
import { APIError, apiRequest, errorMessage } from "../../lib/client-api";
import type { RegistrationItineraryItem } from "../../lib/event-contract";
import { eventDate, eventTime } from "../../lib/format";
import { itineraryNextAction, type ItineraryNextAction } from "../../lib/itinerary";
import { EventFeedback } from "./EventFeedback";
import type { ItineraryCopy } from "./itinerary-copy";
import styles from "./MyEvents.module.css";

type WaitlistQuote = Readonly<{
  id: string;
  amount: number;
  currency: "POINTS";
  expiresAt: string;
}>;

type WaitlistReview = Readonly<{
  quote: WaitlistQuote;
  idempotencyKey: string;
  registrationId: string;
  registrationVersion: number;
  eventId: string;
  eventVersion: number;
  eventTitle: string;
  partySize: number;
  displayTimeZone: string;
  returnFocusTarget: HTMLButtonElement | null;
}>;

type WaitlistRefreshReason = "conflict" | "accepted";

type WaitlistRefreshState = Readonly<
  | { phase: "ready" }
  | { phase: "refreshing" | "required"; reason: WaitlistRefreshReason }
>;

export type ItineraryLoadResult = Readonly<
  | { status: "success"; generation: number }
  | { status: "failed"; reason: "request_failed"; generation: number }
  | {
    status: "superseded";
    reason: "owner_changed" | "newer_generation";
    generation: number;
  }
>;

export function ItineraryCard({
  item,
  serverTime,
  copy,
  locale,
  onChanged,
  onError,
  onWaitlistConflict,
  onWaitlistAcceptance,
}: {
  item: RegistrationItineraryItem;
  serverTime: string;
  copy: ItineraryCopy;
  locale: Locale;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onWaitlistConflict: () => Promise<ItineraryLoadResult>;
  onWaitlistAcceptance: () => Promise<ItineraryLoadResult>;
}) {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const [waitlistReview, setWaitlistReview] = useState<WaitlistReview | null>(null);
  const [waitlistReviewError, setWaitlistReviewError] = useState("");
  const [confirmingWaitlist, setConfirmingWaitlist] = useState(false);
  const [waitlistRefreshState, setWaitlistRefreshState] = useState<WaitlistRefreshState>({
    phase: "ready",
  });
  const quoteGeneration = useRef(0);
  const quoteInFlight = useRef(false);
  const confirmingWaitlistRef = useRef(false);
  const waitlistRefreshInFlight = useRef(false);
  const waitlistTriggerRef = useRef<HTMLButtonElement>(null);
  const suppressWaitlistTriggerFocus = useRef(false);
  const mountedRef = useRef(true);
  const action = itineraryNextAction(item, serverTime);
  const event = item.event;
  const location = event?.format === "online"
    ? copy.online
    : event?.publicArea ?? copy.areaPending;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      quoteGeneration.current += 1;
    };
  }, []);

  const closeWaitlistReview = useCallback(() => {
    if (confirmingWaitlistRef.current) return;
    setWaitlistReview(null);
    setWaitlistReviewError("");
  }, []);

  const shouldRestoreWaitlistTriggerFocus = useCallback(
    () => !suppressWaitlistTriggerFocus.current,
    [],
  );

  async function reviewOffer() {
    if (!event || busy || quoteInFlight.current || waitlistRefreshState.phase !== "ready") return;
    const generation = ++quoteGeneration.current;
    const reviewFacts = Object.freeze({
      registrationId: item.registration.id,
      registrationVersion: item.registration.version,
      eventId: event.id,
      eventVersion: event.version,
      eventTitle: event.title,
      partySize: item.registration.partySize,
      displayTimeZone: event.displayTimeZone,
      returnFocusTarget: waitlistTriggerRef.current,
    });
    quoteInFlight.current = true;
    setBusy(true);
    setWaitlistReviewError("");
    try {
      const payload = await apiRequest<unknown>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({
          purpose: "registration",
          resourceId: event.id,
        }),
      });
      if (generation !== quoteGeneration.current) return;
      const quote = parseWaitlistQuote(payload);
      if (!quote) throw new Error(copy.waitlistQuoteInvalid);
      suppressWaitlistTriggerFocus.current = false;
      setWaitlistReview(Object.freeze({
        ...reviewFacts,
        quote: Object.freeze({ ...quote }),
        idempotencyKey: window.crypto.randomUUID(),
      }));
    } catch {
      if (generation === quoteGeneration.current) {
        onError(copy.waitlistQuoteInvalid);
      }
    } finally {
      if (generation === quoteGeneration.current) {
        quoteInFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function confirmOffer() {
    if (!waitlistReview || confirmingWaitlistRef.current) return;
    const review = waitlistReview;
    confirmingWaitlistRef.current = true;
    setConfirmingWaitlist(true);
    setWaitlistReviewError("");
    try {
      await apiRequest(`/registrations/${review.registrationId}/waitlist-acceptance`, {
        method: "POST",
        authenticated: true,
        idempotencyKey: review.idempotencyKey,
        body: JSON.stringify({
          quoteId: review.quote.id,
          expectedRegistrationVersion: review.registrationVersion,
          expectedEventVersion: review.eventVersion,
        }),
      });
      if (!mountedRef.current) return;
      suppressWaitlistTriggerFocus.current = true;
      setWaitlistReview(null);
      await refreshWaitlistFacts("accepted");
    } catch (error) {
      if (!mountedRef.current) return;
      if (isStaleWaitlistReview(error)) {
        suppressWaitlistTriggerFocus.current = true;
        setWaitlistReview(null);
        await refreshWaitlistFacts("conflict");
      } else {
        setWaitlistReviewError(copy.waitlistAcceptFailed);
      }
    } finally {
      confirmingWaitlistRef.current = false;
      if (mountedRef.current) setConfirmingWaitlist(false);
    }
  }

  async function refreshWaitlistFacts(reason: WaitlistRefreshReason) {
    if (waitlistRefreshInFlight.current) return;
    waitlistRefreshInFlight.current = true;
    setWaitlistRefreshState({ phase: "refreshing", reason });
    try {
      const result = await (reason === "accepted"
        ? onWaitlistAcceptance()
        : onWaitlistConflict());
      if (!mountedRef.current || result.status === "superseded") return;
      setWaitlistRefreshState(result.status === "success"
        ? { phase: "ready" }
        : { phase: "required", reason });
    } catch {
      if (!mountedRef.current) return;
      setWaitlistRefreshState({ phase: "required", reason });
      onError(reason === "accepted"
        ? copy.waitlistAcceptanceRefreshFailed
        : copy.waitlistRefreshFailed);
    } finally {
      waitlistRefreshInFlight.current = false;
    }
  }

  async function retryWaitlistRefresh() {
    if (waitlistRefreshState.phase !== "required") return;
    await refreshWaitlistFacts(waitlistRefreshState.reason);
  }

  async function cancelRegistration() {
    await appDialog.run({
      title: copy.cancel,
      message: copy.cancelConfirmation,
      confirmLabel: copy.cancel,
      destructive: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          await apiRequest(`/registrations/${item.registration.id}/cancel`, {
            method: "POST",
            authenticated: true,
            idempotent: true,
          });
          await onChanged();
        } catch (error) {
          onError(errorMessage(error));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function checkIn() {
    await appDialog.run({
      title: copy.checkIn,
      confirmLabel: copy.checkIn,
      input: { label: copy.checkInCredential, required: true, minLength: 1 },
      onConfirm: async (credential) => {
        setBusy(true);
        try {
          await apiRequest("/checkins", {
            method: "POST",
            authenticated: true,
            idempotent: true,
            body: JSON.stringify({
              registrationId: item.registration.id,
              ...(credential.match(/^\d{6}$/) ? { code: credential } : { token: credential }),
              operationId: window.crypto.randomUUID(),
              deviceRecordedAt: new Date().toISOString(),
            }),
          });
          await onChanged();
        } catch (error) {
          onError(errorMessage(error));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function correctAttendance() {
    await appDialog.run({
      title: copy.correction,
      confirmLabel: copy.correction,
      input: {
        label: copy.correctionPrompt,
        required: true,
        minLength: 3,
        multiline: true,
      },
      onConfirm: async (reason) => {
        setBusy(true);
        try {
          await apiRequest(`/registrations/${item.registration.id}/checkin-corrections`, {
            method: "POST",
            authenticated: true,
            body: JSON.stringify({ reason }),
          });
          onError(copy.correctionSent);
          await onChanged();
        } catch (error) {
          onError(errorMessage(error));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  return (
    <>
      <article
        id={`itinerary-registration-${item.registration.id}`}
        className={styles.card}
        tabIndex={-1}
        aria-labelledby={`itinerary-registration-title-${item.registration.id}`}
      >
      <div className={styles.cardBody}>
        <div className={styles.cardMeta}>
          {event?.startsAt ? (
            <time dateTime={event.startsAt}>
              {eventDate(event.startsAt, locale, event.displayTimeZone)}
            </time>
          ) : null}
          <span
            className={styles.status}
            aria-label={`${copy.status}: ${copy.statuses[item.registration.status]}`}
          >
            {copy.statuses[item.registration.status]}
          </span>
        </div>

        {event ? (
          <>
            <h2 id={`itinerary-registration-title-${item.registration.id}`}>
              <Link href={`/e/${event.publicSlug}`}>{event.title}</Link>
            </h2>
            <div className={styles.facts}>
              <span>{eventTime(event.startsAt, event.endsAt, locale, event.displayTimeZone)}</span>
              <span>{location}</span>
              <span>{copy.partySize.replace("{count}", String(item.registration.partySize))}</span>
            </div>
          </>
        ) : (
          <>
            <h2 id={`itinerary-registration-title-${item.registration.id}`}>{copy.unavailable}</h2>
            <div className={styles.facts}>
              <span>{copy.partySize.replace("{count}", String(item.registration.partySize))}</span>
            </div>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <ItineraryAction
          action={action}
          copy={copy}
          busy={busy}
          locale={locale}
          acceptTriggerRef={waitlistTriggerRef}
          waitlistRefreshState={waitlistRefreshState}
          onAccept={reviewOffer}
          onRefreshWaitlist={retryWaitlistRefresh}
          onCheckIn={checkIn}
          onCorrection={correctAttendance}
        />

        {waitlistRefreshState.phase === "ready"
        && (item.registration.availableActions.includes("cancelRegistration")
          || (event && action.kind !== "open_event")) ? (
          <details className={styles.more}>
            <summary>{copy.more}</summary>
            <div role="menu">
              {event && action.kind !== "open_event" ? (
                <Link role="menuitem" href={`/e/${event.publicSlug}`}>{copy.open}</Link>
              ) : null}
              {item.registration.availableActions.includes("cancelRegistration") ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void cancelRegistration()}
                >
                  {copy.cancel}
                </button>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
      </article>

      {waitlistReview ? (
        <WaitlistReviewDialog
          review={waitlistReview}
          copy={copy}
          locale={locale}
          confirming={confirmingWaitlist}
          error={waitlistReviewError}
          shouldRestoreReturnFocus={shouldRestoreWaitlistTriggerFocus}
          onCancel={closeWaitlistReview}
          onConfirm={confirmOffer}
        />
      ) : null}
    </>
  );
}

function ItineraryAction({
  action,
  copy,
  busy,
  locale,
  acceptTriggerRef,
  waitlistRefreshState,
  onAccept,
  onRefreshWaitlist,
  onCheckIn,
  onCorrection,
}: {
  action: ItineraryNextAction;
  copy: ItineraryCopy;
  busy: boolean;
  locale: Locale;
  acceptTriggerRef: RefObject<HTMLButtonElement | null>;
  waitlistRefreshState: WaitlistRefreshState;
  onAccept: () => Promise<void>;
  onRefreshWaitlist: () => Promise<void>;
  onCheckIn: () => Promise<void>;
  onCorrection: () => Promise<void>;
}) {
  let control: React.ReactNode;

  if (waitlistRefreshState.phase !== "ready") {
    const refreshingFacts = waitlistRefreshState.phase === "refreshing";
    const acceptedRefresh = waitlistRefreshState.reason === "accepted";
    control = (
      <button
        ref={acceptTriggerRef}
        type="button"
        aria-disabled={refreshingFacts}
        aria-busy={refreshingFacts}
        onClick={() => {
          if (!refreshingFacts) void onRefreshWaitlist();
        }}
      >
        {refreshingFacts
          ? acceptedRefresh
            ? copy.waitlistAcceptanceRefreshing
            : copy.waitlistRefreshingFacts
          : acceptedRefresh
            ? copy.waitlistRetryAcceptanceRefresh
            : copy.waitlistRetryRefresh}
      </button>
    );
  } else if (action.kind === "accept_offer") {
    control = (
      <button
        ref={acceptTriggerRef}
        type="button"
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => {
          if (!busy) void onAccept();
        }}
      >
        {busy ? copy.waitlistQuoteLoading : copy.accept}
      </button>
    );
  } else if (action.kind === "check_in") {
    control = <button type="button" disabled={busy} onClick={() => void onCheckIn()}>{copy.checkIn}</button>;
  } else if (action.kind === "correct_attendance") {
    control = <button type="button" disabled={busy} onClick={() => void onCorrection()}>{copy.correction}</button>;
  } else if (action.kind === "leave_feedback") {
    control = <EventFeedback registrationId={action.registrationId} locale={locale} />;
  } else if (action.kind === "view_status") {
    control = <Link href={`/me/events?registration=${action.registrationId}`}>{copy.viewStatus}</Link>;
  } else if (action.kind === "open_event") {
    control = <Link href={`/e/${action.publicSlug}`}>{copy.open}</Link>;
  } else {
    control = <button type="button" disabled>{copy.unavailable}</button>;
  }

  return (
    <div className={styles.primaryAction} data-testid="itinerary-primary-action">
      {control}
    </div>
  );
}

function WaitlistReviewDialog({
  review,
  copy,
  locale,
  confirming,
  error,
  shouldRestoreReturnFocus,
  onCancel,
  onConfirm,
}: {
  review: WaitlistReview;
  copy: ItineraryCopy;
  locale: Locale;
  confirming: boolean;
  error: string;
  shouldRestoreReturnFocus: () => boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const confirmingRef = useRef(confirming);
  const previousConfirmingRef = useRef(confirming);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `waitlist-review-title-${review.registrationId}`;
  const bodyId = `waitlist-review-body-${review.registrationId}`;

  useEffect(() => {
    confirmingRef.current = confirming;
    if (previousConfirmingRef.current && !confirming && error) {
      confirmButtonRef.current?.focus();
    }
    previousConfirmingRef.current = confirming;
  }, [confirming, error]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();

    function handleKeyDown(keyEvent: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (keyEvent.key === "Escape") {
        if (confirmingRef.current) return;
        keyEvent.preventDefault();
        onCancel();
        return;
      }
      if (keyEvent.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) {
        keyEvent.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (!activeElement || !dialog.contains(activeElement)) {
        keyEvent.preventDefault();
        (keyEvent.shiftKey ? last : first).focus();
      } else if (keyEvent.shiftKey && activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const returnFocusTarget = review.returnFocusTarget;
      if (
        shouldRestoreReturnFocus()
        && returnFocusTarget?.isConnected
        && !returnFocusTarget.disabled
        && returnFocusTarget.getAttribute("aria-disabled") !== "true"
      ) returnFocusTarget.focus();
    };
  }, [onCancel, review.returnFocusTarget, shouldRestoreReturnFocus]);

  if (typeof document === "undefined") return null;

  const points = copy.waitlistPointsAmount.replace("{count}", String(review.quote.amount));
  const expiry = copy.waitlistExpiry.replace(
    "{time}",
    formatQuoteExpiry(review.quote.expiresAt, locale, review.displayTimeZone),
  );
  const confirmLabel = copy.waitlistConfirm.replace("{count}", String(review.quote.amount));

  return createPortal(
    <div
      className={styles.waitlistBackdrop}
      role="presentation"
      onMouseDown={(pointerEvent) => {
        if (!confirming && pointerEvent.target === pointerEvent.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.waitlistDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <header className={styles.waitlistDialogHeader}>
          <div>
            <span>{copy.waitlistReviewEyebrow}</span>
            <h2 id={titleId}>{copy.waitlistReviewTitle}</h2>
          </div>
          <button
            type="button"
            className={styles.waitlistDialogClose}
            aria-label={copy.close}
            disabled={confirming}
            onClick={onCancel}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className={styles.waitlistDialogBody}>
          <p id={bodyId} className={styles.waitlistDialogIntro}>{copy.waitlistReviewBody}</p>
          <dl className={styles.waitlistReviewFacts}>
            <div className={styles.waitlistEventFact}>
              <dt>{copy.waitlistEvent}</dt>
              <dd>{review.eventTitle}</dd>
            </div>
            <div>
              <dt>{copy.waitlistParty}</dt>
              <dd>{copy.partySize.replace("{count}", String(review.partySize))}</dd>
            </div>
            <div className={styles.waitlistPointsFact}>
              <dt>{copy.waitlistPoints}</dt>
              <dd><strong>{points}</strong></dd>
            </div>
          </dl>
          <p className={styles.waitlistExpiry}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>{expiry}</span>
          </p>
          <div className={styles.waitlistFeeBoundary}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m5 12 4 4L19 6" />
            </svg>
            <div>
              <strong>{copy.waitlistNoHiddenFees}</strong>
              <p>{copy.waitlistPointBoundary}</p>
            </div>
          </div>
          {error ? <p className={styles.waitlistDialogError} role="alert">{error}</p> : null}
        </div>

        <footer className={styles.waitlistDialogActions}>
          <button
            type="button"
            data-initial-focus
            disabled={confirming}
            onClick={onCancel}
          >
            {copy.waitlistCancel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            aria-disabled={confirming}
            aria-busy={confirming}
            onClick={() => {
              if (!confirmingRef.current) void onConfirm();
            }}
          >
            {confirming ? copy.waitlistConfirming : confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function parseWaitlistQuote(payload: unknown): WaitlistQuote | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  const expiresAt = typeof candidate.expiresAt === "string" ? candidate.expiresAt : "";
  if (
    typeof candidate.id !== "string"
    || !candidate.id
    || typeof candidate.amount !== "number"
    || !Number.isSafeInteger(candidate.amount)
    || candidate.amount < 0
    || candidate.currency !== "POINTS"
    || !expiresAt
    || !Number.isFinite(Date.parse(expiresAt))
  ) return null;
  return {
    id: candidate.id,
    amount: candidate.amount,
    currency: "POINTS",
    expiresAt,
  };
}

function isStaleWaitlistReview(error: unknown): boolean {
  return error instanceof APIError
    && (error.status === 409 || error.body.code === "QUOTE_EXPIRED");
}

function formatQuoteExpiry(expiresAt: string, locale: Locale, timeZone: string): string {
  const languageTag = locale === "zh-Hans" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en-US";
  try {
    return new Intl.DateTimeFormat(languageTag, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(expiresAt));
  } catch {
    return new Intl.DateTimeFormat(languageTag, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Tokyo",
    }).format(new Date(expiresAt));
  }
}
