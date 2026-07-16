"use client";

import Link from "next/link";
import { useState } from "react";

import { useAppDialog } from "../../components/AppDialog";
import type { Locale } from "../../i18n/messages";
import { apiRequest, errorMessage } from "../../lib/client-api";
import type { RegistrationItineraryItem } from "../../lib/event-contract";
import { eventDate, eventTime } from "../../lib/format";
import { itineraryNextAction, type ItineraryNextAction } from "../../lib/itinerary";
import { EventFeedback } from "./EventFeedback";
import type { ItineraryCopy } from "./itinerary-copy";
import styles from "./MyEvents.module.css";

export function ItineraryCard({
  item,
  serverTime,
  copy,
  locale,
  onChanged,
  onError,
}: {
  item: RegistrationItineraryItem;
  serverTime: string;
  copy: ItineraryCopy;
  locale: Locale;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const action = itineraryNextAction(item, serverTime);
  const event = item.event;
  const location = event?.format === "online"
    ? copy.online
    : event?.publicArea ?? copy.areaPending;

  async function acceptOffer() {
    setBusy(true);
    try {
      await apiRequest(`/registrations/${item.registration.id}/waitlist-acceptance`, {
        method: "POST",
        authenticated: true,
        idempotent: true,
      });
      await onChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
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
    <article className={styles.card}>
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
            <h2>
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
            <h2>{copy.unavailable}</h2>
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
          onAccept={acceptOffer}
          onCheckIn={checkIn}
          onCorrection={correctAttendance}
        />

        {(item.registration.availableActions.includes("cancelRegistration")
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
  );
}

function ItineraryAction({
  action,
  copy,
  busy,
  locale,
  onAccept,
  onCheckIn,
  onCorrection,
}: {
  action: ItineraryNextAction;
  copy: ItineraryCopy;
  busy: boolean;
  locale: Locale;
  onAccept: () => Promise<void>;
  onCheckIn: () => Promise<void>;
  onCorrection: () => Promise<void>;
}) {
  let control: React.ReactNode;

  if (action.kind === "accept_offer") {
    control = <button type="button" disabled={busy} onClick={() => void onAccept()}>{copy.accept}</button>;
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
