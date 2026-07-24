"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { Locale, MessageKey } from "../../i18n/messages";
import { formatMessage } from "../../i18n/messages";
import { apiRequest } from "../../lib/client-api";
import styles from "./EventGoingPreview.module.css";

interface GoingPreviewPerson {
  userId: string;
  displayName: string;
  avatarURL: string | null;
}

interface GoingPreviewPayload {
  confirmedCount: number;
  previews: GoingPreviewPerson[];
  hasMore: boolean;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; payload: GoingPreviewPayload };

/**
 * "Who's coming" social proof. The endpoint is public and still reports the
 * confirmed count when the organizer hides the guest list, so a hidden list is
 * rendered as an honest count-only state instead of disappearing silently.
 */
export function EventGoingPreview({ eventId, locale }: { eventId: string; locale: Locale }) {
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    formatMessage(locale, key, values);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void apiRequest<GoingPreviewPayload>(`/events/${eventId}/going-preview`)
      .then((payload) => {
        if (!active) return;
        setState({ kind: "ready", payload: normalizePreview(payload) });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  // A silent section is better than a skeleton while the count is unknown, and
  // social proof is never worth an error banner on a public event page.
  if (state.kind === "loading" || state.kind === "error") return null;

  const { confirmedCount, previews, hasMore } = state.payload;
  if (confirmedCount === 0) return null;
  const overflow = hasMore ? Math.max(0, confirmedCount - previews.length) : 0;

  return (
    <section className={styles.section} aria-label={t("going.eyebrow")}>
      <p className={styles.eyebrow}>{t("going.eyebrow")}</p>
      <div className={styles.heading}>
        <h2>{t("going.title", { count: confirmedCount })}</h2>
      </div>
      {previews.length ? (
        <ul className={styles.people}>
          {previews.map((person) => (
            <li key={person.userId}>
              <Link
                className={styles.person}
                href={`/u/${encodeURIComponent(person.userId)}`}
                aria-label={t("going.profileLabel", { name: person.displayName })}
              >
                <Avatar person={person} />
                <span>{person.displayName}</span>
              </Link>
            </li>
          ))}
          {overflow > 0 ? (
            <li>
              <span className={styles.overflow}>{t("going.more", { count: overflow })}</span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className={styles.note}>{t("going.hidden")}</p>
      )}
    </section>
  );
}

function Avatar({ person }: { person: GoingPreviewPerson }) {
  if (person.avatarURL) {
    return (
      <span className={styles.avatar} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={person.avatarURL} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span className={styles.avatar} aria-hidden="true">
      {Array.from(person.displayName.replace(/^@/, ""))[0] ?? "·"}
    </span>
  );
}

function normalizePreview(payload: GoingPreviewPayload): GoingPreviewPayload {
  const previews = Array.isArray(payload?.previews)
    ? payload.previews.filter((person) => typeof person?.userId === "string")
    : [];
  const confirmedCount = Number.isFinite(payload?.confirmedCount)
    ? Math.max(0, Math.trunc(payload.confirmedCount))
    : 0;
  return {
    confirmedCount: Math.max(confirmedCount, previews.length),
    previews: previews.map((person) => ({
      userId: person.userId,
      displayName: typeof person.displayName === "string" && person.displayName.trim()
        ? person.displayName
        : "·",
      avatarURL: typeof person.avatarURL === "string" ? person.avatarURL : null,
    })),
    hasMore: Boolean(payload?.hasMore),
  };
}
