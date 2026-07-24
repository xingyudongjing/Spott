"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../components/I18nProvider";
import type { Locale, MessageKey } from "../../i18n/messages";
import { apiRequest, errorMessage } from "../../lib/client-api";
import { isTimeOfDay, parseQuietHours } from "../../lib/quiet-hours";

/**
 * Notification preference editor (GET|PUT /v1/notifications/preferences).
 *
 * The API stores one row per notification type; quiet hours live on each row but
 * the product treats them as one window, so a change writes every type. Push is
 * only delivered by the iOS app today — the copy says so instead of implying a
 * web push that never arrives.
 */

const notificationTypes = [
  "event.reminder",
  "event.critical",
  "registration.status",
  "group.update",
  "recommendation",
] as const;

type NotificationType = (typeof notificationTypes)[number];

interface Channels {
  inApp: boolean;
  push: boolean;
  email: boolean;
}

interface PreferenceRow {
  type: string;
  inApp: boolean;
  push: boolean;
  email: boolean;
  quietHours: string | null;
  locale: Locale;
}

const defaultChannels: Channels = { inApp: true, push: true, email: false };
const defaultQuiet = { start: "22:00", end: "08:00" };

export function NotificationPreferences({ preferredLocale }: { preferredLocale: Locale }) {
  const { t } = useI18n();
  const [channels, setChannels] = useState<Record<NotificationType, Channels> | null>(null);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quiet, setQuiet] = useState(defaultQuiet);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const loadErrorMessage = t("prefs.error");

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const page = await apiRequest<{ items: PreferenceRow[] }>("/notifications/preferences", {
        authenticated: true,
      });
      const next = {} as Record<NotificationType, Channels>;
      for (const type of notificationTypes) {
        const stored = page.items.find((item) => item.type === type);
        next[type] = stored
          ? { inApp: stored.inApp, push: stored.push, email: stored.email }
          : { ...defaultChannels };
      }
      setChannels(next);
      const storedQuiet = page.items
        .map((item) => parseQuietHours(item.quietHours))
        .find((value) => value !== null);
      if (storedQuiet) {
        setQuiet(storedQuiet);
        setQuietEnabled(true);
      }
      setMessage("");
    } catch {
      // A designed message beats echoing a transport error at the member.
      setLoadFailed(true);
      setMessage(loadErrorMessage);
    }
  }, [loadErrorMessage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function persist(
    values: Record<NotificationType, Channels>,
    quietWindow: { enabled: boolean; start: string; end: string },
    types: readonly NotificationType[],
  ) {
    setBusy(true);
    setMessage("");
    try {
      for (const type of types) {
        await apiRequest(`/notifications/preferences/${type}`, {
          method: "PUT",
          authenticated: true,
          body: JSON.stringify({
            ...values[type],
            ...(quietWindow.enabled ? { quietStart: quietWindow.start, quietEnd: quietWindow.end } : {}),
            locale: preferredLocale,
          }),
        });
      }
    } catch (error) {
      setMessage(errorMessage(error));
      await load();
    } finally {
      setBusy(false);
    }
  }

  function updateChannel(type: NotificationType, channel: keyof Channels, value: boolean) {
    if (!channels) return;
    const next = { ...channels, [type]: { ...channels[type], [channel]: value } };
    setChannels(next);
    void persist(next, { enabled: quietEnabled, ...quiet }, [type]);
  }

  function commitQuietHours(enabled: boolean, value: { start: string; end: string }) {
    if (!channels) return;
    if (enabled && (!isTimeOfDay(value.start) || !isTimeOfDay(value.end))) {
      setMessage(t("prefs.quietInvalid"));
      return;
    }
    void persist(channels, { enabled, ...value }, notificationTypes);
  }

  // The editor lives inside the profile form; Enter must commit the window
  // instead of submitting the surrounding form.
  function submitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.blur();
  }

  const quietSummary = quietEnabled
    ? t(quiet.end <= quiet.start ? "prefs.quietOvernight" : "prefs.quietSameDay", {
        start: quiet.start,
        end: quiet.end,
      })
    : "";

  return (
    <div className="settings-section">
      <h2>{t("prefs.title")}</h2>
      <p className="achievement-intro">{t("prefs.body")}</p>

      {message && (
        <p className="form-message" role={loadFailed ? "alert" : "status"}>
          {message}
        </p>
      )}

      {channels === null ? (
        loadFailed ? (
          <button className="secondary-action compact" type="button" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        ) : (
          <div className="loading-state">
            <span />
            <p>{t("prefs.loading")}</p>
          </div>
        )
      ) : (
        <>
          <div className="pref-table" aria-busy={busy}>
            <div className="pref-head" aria-hidden="true">
              <span>{t("prefs.channels")}</span>
              <span>{t("prefs.channelInApp")}</span>
              <span>{t("prefs.channelPush")}</span>
              <span>{t("prefs.channelEmail")}</span>
            </div>
            {notificationTypes.map((type) => {
              const title = t(`prefs.type.${type}.title` as MessageKey);
              return (
                <div className="pref-row" key={type}>
                  <div>
                    <strong>{title}</strong>
                    <small>{t(`prefs.type.${type}.detail` as MessageKey)}</small>
                  </div>
                  {(["inApp", "push", "email"] as const).map((channel) => (
                    <input
                      key={channel}
                      type="checkbox"
                      checked={channels[type][channel]}
                      disabled={busy}
                      aria-label={`${title} · ${t(channelLabelKey(channel))}`}
                      onChange={(event) => updateChannel(type, channel, event.target.checked)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          <p className="pref-note">{t("prefs.pushNote")}</p>

          <label className="toggle-row">
            <span>
              <strong>{t("prefs.quietTitle")}</strong>
              <small>{t("prefs.quietBody")}</small>
            </span>
            <input
              type="checkbox"
              checked={quietEnabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                setQuietEnabled(enabled);
                commitQuietHours(enabled, quiet);
              }}
            />
          </label>
          {quietEnabled && (
            <div className="pref-quiet">
              <label className="form-field">
                {t("prefs.quietStart")}
                <input
                  type="time"
                  value={quiet.start}
                  disabled={busy}
                  onChange={(event) => setQuiet({ ...quiet, start: event.target.value })}
                  onBlur={() => commitQuietHours(true, quiet)}
                  onKeyDown={submitOnEnter}
                />
              </label>
              <label className="form-field">
                {t("prefs.quietEnd")}
                <input
                  type="time"
                  value={quiet.end}
                  disabled={busy}
                  onChange={(event) => setQuiet({ ...quiet, end: event.target.value })}
                  onBlur={() => commitQuietHours(true, quiet)}
                  onKeyDown={submitOnEnter}
                />
              </label>
              <p>{quietSummary}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function channelLabelKey(channel: keyof Channels): MessageKey {
  if (channel === "inApp") return "prefs.channelInApp";
  if (channel === "push") return "prefs.channelPush";
  return "prefs.channelEmail";
}
