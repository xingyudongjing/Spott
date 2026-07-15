"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppDialog } from "../../components/AppDialog";
import { EventCover } from "../../components/EventCover";
import { useI18n } from "../../components/I18nProvider";
import type { Locale } from "../../i18n/messages";
import { apiRequest, errorMessage, type RegistrationView } from "../../lib/client-api";
import type { EventView } from "../../lib/demo-data";
import { eventDate, eventTime } from "../../lib/format";
import { DashboardNav } from "../DashboardNav";
import { EventFeedback } from "./EventFeedback";

type RegistrationWithEvent = RegistrationView & { event?: EventView };
type Tab = "upcoming" | "waitlist" | "pending" | "past";

const tabValues: Tab[] = ["upcoming", "waitlist", "pending", "past"];

export function MyEventsClient() {
  const { locale } = useI18n();
  const appDialog = useAppDialog();
  const [items, setItems] = useState<RegistrationWithEvent[]>([]);
  const [tab, setTab] = useState<Tab>("upcoming");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const registrations = await apiRequest<{ items: RegistrationView[] }>(
        "/me/registrations?limit=100",
        { authenticated: true },
      );
      const enriched = await Promise.all(
        registrations.items.map(async (registration) => {
          try {
            const event = await apiRequest<EventView>(`/events/${registration.eventId}`, {
              authenticated: true,
            });
            return { ...registration, event };
          } catch {
            return registration;
          }
        }),
      );
      setItems(enriched);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(
    () => ({
      upcoming: items.filter(
        (item) => ["confirmed", "checked_in"].includes(item.status) && !isPastEvent(item.event),
      ).length,
      waitlist: items.filter((item) => ["waitlisted", "offered"].includes(item.status)).length,
      pending: items.filter((item) => item.status === "pending").length,
      past: items.filter(isPastRegistration).length,
    }),
    [items],
  );

  const visible = items.filter((item) => {
    if (tab === "upcoming")
      return ["confirmed", "checked_in"].includes(item.status) && !isPastEvent(item.event);
    if (tab === "waitlist") return ["waitlisted", "offered"].includes(item.status);
    if (tab === "pending") return item.status === "pending";
    return isPastRegistration(item);
  });

  const copy =
    locale === "ja"
      ? {
          title: "参加予定",
          body: "申込、キャンセル待ち、チェックインは iOS と同じ状態です。",
          discover: "イベントを探す",
          syncing: "申込状況を同期中…",
          empty: "この一覧にはイベントがありません",
          emptyBody: "申込、キャンセル待ち、キャンセルの状態は Web と iOS に同期されます。",
          unavailable: "イベントを表示できません",
          status: "申込状況",
          ticket: "当日は6桁コードまたはQRトークンでチェックインできます",
          accept: "枠を受け取る",
          cancel: "申込をキャンセル",
          checkin: "チェックイン",
          correction: "出席記録を修正",
          correctionPrompt: "出席したことが確認できる状況を入力してください（3文字以上）。",
          correctionSent: "出席記録の修正依頼を送信しました。主催者の確認をお待ちください。",
          open: "開く",
        }
      : locale === "en"
        ? {
            title: "My events",
            body: "Registration, waitlists, and check-in use the same state as iOS.",
            discover: "Discover events",
            syncing: "Syncing registrations…",
            empty: "No events in this view",
            emptyBody: "Registrations, waitlists, and cancellations stay in sync across Web and iOS.",
            unavailable: "Event unavailable",
            status: "Registration status",
            ticket: "Check in on the day with a 6-digit code or QR token",
            accept: "Accept spot",
            cancel: "Cancel registration",
            checkin: "Check in",
            correction: "Correct attendance",
            correctionPrompt: "Describe why your attendance record should be corrected (at least 3 characters).",
            correctionSent: "Attendance correction sent. The host will review it.",
            open: "Open",
          }
        : {
            title: "我的活动",
            body: "报名、候补与签到状态和 iOS 使用同一份数据。",
            discover: "发现更多",
            syncing: "正在同步报名状态…",
            empty: "当前列表还没有活动",
            emptyBody: "报名、候补和取消状态会在 Web 与 iOS 之间同步。",
            unavailable: "活动暂不可见",
            status: "报名状态",
            ticket: "活动当天可用 6 位签到码或二维码令牌签到",
            accept: "接受名额",
            cancel: "取消报名",
            checkin: "现场签到",
            correction: "申请补签",
            correctionPrompt: "请说明需要修正到场记录的原因（至少 3 个字）。",
            correctionSent: "补签申请已提交，等待主办方处理。",
            open: "打开",
          };

  async function cancel(id: string) {
    await appDialog.run({
      title: copy.cancel,
      message: locale === "ja"
        ? "この申込をキャンセルしますか？条件を満たすポイントは自動で返還されます。"
        : locale === "en"
          ? "Cancel this registration? Eligible points will be refunded automatically."
          : "确定取消这次报名吗？符合规则的积分会自动退回。",
      confirmLabel: copy.cancel,
      destructive: true,
      onConfirm: async () => {
        setBusyId(id);
        try {
          await apiRequest(`/registrations/${id}/cancel`, {
            method: "POST",
            authenticated: true,
            idempotent: true,
          });
          await load();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusyId("");
        }
      },
    });
  }

  async function accept(id: string) {
    setBusyId(id);
    try {
      await apiRequest(`/registrations/${id}/waitlist-acceptance`, {
        method: "POST",
        authenticated: true,
        idempotent: true,
      });
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId("");
    }
  }

  async function checkIn(registration: RegistrationWithEvent) {
    const credentialLabel = locale === "ja"
      ? "主催者の6桁コード、またはQRから取得したトークンを入力してください。"
      : locale === "en"
        ? "Enter the host’s 6-digit code or a token from the QR code."
        : "请输入主办方提供的 6 位签到码，或粘贴二维码中的令牌。";
    await appDialog.run({
      title: copy.checkin,
      confirmLabel: copy.checkin,
      input: { label: credentialLabel, required: true, minLength: 1 },
      onConfirm: async (value) => {
        setBusyId(registration.id);
        setMessage("");
        try {
          await apiRequest("/checkins", {
            method: "POST",
            authenticated: true,
            idempotent: true,
            body: JSON.stringify({
              registrationId: registration.id,
              ...(value.match(/^\d{6}$/) ? { code: value } : { token: value }),
              operationId: window.crypto.randomUUID(),
              deviceRecordedAt: new Date().toISOString(),
            }),
          });
          await load();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusyId("");
        }
      },
    });
  }

  async function requestCorrection(registration: RegistrationWithEvent) {
    await appDialog.run({
      title: copy.correction,
      confirmLabel: copy.correction,
      input: { label: copy.correctionPrompt, required: true, minLength: 3, multiline: true },
      onConfirm: async (reason) => {
        setBusyId(registration.id);
        setMessage("");
        try {
          await apiRequest(`/registrations/${registration.id}/checkin-corrections`, {
            method: "POST",
            authenticated: true,
            body: JSON.stringify({ reason }),
          });
          setMessage(copy.correctionSent);
          await load();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusyId("");
        }
      },
    });
  }

  return (
    <main className="dashboard-shell">
      <DashboardNav current="events" />
      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">MY SPOTT / SYNCED</span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <Link className="create-button" href="/discover">
            {copy.discover}
          </Link>
        </div>
        <div className="dashboard-tabs">
          {tabValues.map((value) => (
            <button
              key={value}
              className={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {tabLabel(value, locale)} <span>{counts[value]}</span>
            </button>
          ))}
        </div>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{copy.syncing}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
            <p>{copy.emptyBody}</p>
            <Link className="primary-action compact" href="/discover">
              {copy.discover}
            </Link>
          </div>
        ) : (
          <div className="ticket-list">
            {visible.map((registration) => {
              const event = registration.event;
              if (!event)
                return (
                  <article className="ticket-card missing-event" key={registration.id}>
                    <div>
                      <h2>{copy.unavailable}</h2>
                      <p>
                        {copy.status}: {statusLabel(registration.status, locale)}
                      </p>
                    </div>
                  </article>
                );
              const ended = isPastEvent(event);
              const correctionEligible =
                isWithinCorrectionWindow(event) &&
                ["confirmed", "no_show", "attendance_disputed"].includes(registration.status);
              return (
                <article className="ticket-card" key={registration.id}>
                  <EventCover event={event} />
                  <div>
                    <span className="event-date">
                      {eventDate(event.startsAt, locale)} ·{" "}
                      {eventTime(event.startsAt, event.endsAt, locale)}
                    </span>
                    <h2>{event.title}</h2>
                    <p>{event.publicArea}</p>
                    <div className="tag-row">
                      <span>{statusLabel(registration.status, locale)}</span>
                      {registration.status === "confirmed" && !ended && <span>{copy.ticket}</span>}
                    </div>
                    <div className="inline-actions">
                      {registration.status === "offered" && (
                        <button
                          disabled={busyId === registration.id}
                          onClick={() => void accept(registration.id)}
                        >
                          {copy.accept}
                        </button>
                      )}
                      {registration.status === "confirmed" && !ended && (
                        <button
                          disabled={busyId === registration.id}
                          onClick={() => void checkIn(registration)}
                        >
                          {copy.checkin}
                        </button>
                      )}
                      {["pending", "confirmed", "waitlisted", "offered"].includes(
                        registration.status,
                      ) && !ended && (
                        <button
                          disabled={busyId === registration.id}
                          onClick={() => void cancel(registration.id)}
                        >
                          {copy.cancel}
                        </button>
                      )}
                      {correctionEligible && (
                        <button
                          disabled={busyId === registration.id}
                          onClick={() => void requestCorrection(registration)}
                        >
                          {copy.correction}
                        </button>
                      )}
                    </div>
                    {ended && registration.status === "checked_in" && (
                      <EventFeedback registrationId={registration.id} locale={locale} />
                    )}
                  </div>
                  <Link href={`/e/${event.publicSlug}`}>{copy.open} ↗</Link>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function tabLabel(tab: Tab, locale: Locale): string {
  const labels: Record<Tab, [string, string, string]> = {
    upcoming: ["即将开始", "参加予定", "Upcoming"],
    waitlist: ["候补", "キャンセル待ち", "Waitlist"],
    pending: ["待确认", "承認待ち", "Pending"],
    past: ["过去", "過去", "Past"],
  };
  return labels[tab][locale === "ja" ? 1 : locale === "en" ? 2 : 0];
}

function statusLabel(status: string, locale: Locale): string {
  const labels: Record<string, [string, string, string]> = {
    pending: ["等待主办方确认", "主催者の承認待ち", "Awaiting host approval"],
    confirmed: ["已确认", "参加確定", "Confirmed"],
    waitlisted: ["候补中", "キャンセル待ち", "Waitlisted"],
    offered: ["名额已保留，请确认", "枠を確保中・要確認", "Spot held—please confirm"],
    checked_in: ["已到场", "チェックイン済み", "Checked in"],
    cancelled: ["已取消", "キャンセル済み", "Cancelled"],
    event_cancelled: ["活动已取消", "イベント中止", "Event cancelled"],
    rejected: ["未通过", "承認されませんでした", "Not approved"],
    no_show: ["未到场", "欠席", "No-show"],
    correction_pending: ["补签审核中", "出席記録の確認中", "Attendance correction pending"],
    attendance_disputed: ["到场记录有争议", "出席記録の確認が必要", "Attendance disputed"],
  };
  return labels[status]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? status;
}

function isPastEvent(event?: EventView): boolean {
  return Boolean(event && new Date(event.endsAt).getTime() < Date.now());
}

function isWithinCorrectionWindow(event?: EventView): boolean {
  if (!event) return false;
  const elapsed = Date.now() - new Date(event.endsAt).getTime();
  return elapsed >= 0 && elapsed <= 48 * 60 * 60 * 1000;
}

function isPastRegistration(item: RegistrationWithEvent): boolean {
  return (
    [
      "cancelled",
      "event_cancelled",
      "rejected",
      "no_show",
      "correction_pending",
      "attendance_disputed",
    ].includes(item.status) || isPastEvent(item.event)
  );
}
