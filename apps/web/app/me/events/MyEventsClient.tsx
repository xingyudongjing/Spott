"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppDialog } from "../../components/AppDialog";
import { useI18n } from "../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../lib/client-api";
import {
  parseRegistrationItineraryPage,
  type RegistrationItineraryItem,
  type RegistrationItineraryPage,
} from "../../lib/event-contract";
import { eventDate, eventTime } from "../../lib/format";
import {
  groupItinerary,
  itineraryNextAction,
  type ItineraryGroup,
  type ItineraryNextAction,
} from "../../lib/itinerary";
import { DashboardNav } from "../DashboardNav";
import { EventFeedback } from "./EventFeedback";

const tabs: ItineraryGroup[] = ["upcoming", "waitlist", "pending", "past"];

export function MyEventsClient() {
  const { locale } = useI18n();
  const copy = itineraryCopy(locale);
  const [page, setPage] = useState<RegistrationItineraryPage | null>(null);
  const [tab, setTab] = useState<ItineraryGroup>("upcoming");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const payload = await apiRequest<unknown>("/me/registrations?limit=100", {
        authenticated: true,
      });
      setPage(parseRegistrationItineraryPage(payload));
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const grouped = useMemo(() => page ? groupItinerary(page) : null, [page]);
  const visible = grouped?.[tab] ?? [];

  return (
    <main className="dashboard-shell">
      <DashboardNav current="events" />
      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? copy.refreshing : copy.refresh}
            </button>
            <Link className="create-button" href="/discover">{copy.discover}</Link>
          </div>
        </div>

        <div className="dashboard-tabs" role="tablist" aria-label={copy.title}>
          {tabs.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {copy.tabs[value]} <span>{grouped?.[value].length ?? 0}</span>
            </button>
          ))}
        </div>

        {message && page ? <p className="form-message" role="status">{message}</p> : null}
        {message && !page ? <p className="form-message" role="alert">{message}</p> : null}

        {loading && !page ? (
          <div className="loading-state"><span /><p>{copy.loading}</p></div>
        ) : visible.length === 0 ? (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
            <p>{copy.emptyBody}</p>
            <Link className="primary-action compact" href="/discover">{copy.discover}</Link>
          </div>
        ) : (
          <div className="ticket-list">
            {visible.map((item) => (
              <ItineraryRow
                key={item.registration.id}
                item={item}
                serverTime={page!.serverTime}
                copy={copy}
                locale={locale}
                onChanged={load}
                onError={setMessage}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function ItineraryRow({
  item,
  serverTime,
  copy,
  locale,
  onChanged,
  onError,
}: {
  item: RegistrationItineraryItem;
  serverTime: string;
  copy: ReturnType<typeof itineraryCopy>;
  locale: "zh-Hans" | "ja" | "en";
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const action = itineraryNextAction(item, serverTime);
  const event = item.event;

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
      input: { label: copy.correctionPrompt, required: true, minLength: 3, multiline: true },
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
    <article className="ticket-card">
      <div>
        {event ? (
          <>
            <span className="event-date">
              {eventDate(event.startsAt, locale, event.displayTimeZone)} · {eventTime(event.startsAt, event.endsAt, locale, event.displayTimeZone)}
            </span>
            <h2>{event.title}</h2>
            <p>{event.publicArea ?? copy.areaPending}</p>
          </>
        ) : (
          <>
            <h2>{copy.unavailable}</h2>
            <p>{copy.status}: {copy.statuses[item.registration.status] ?? item.registration.status}</p>
          </>
        )}
        <p>{copy.partySize.replace("{count}", String(item.registration.partySize))}</p>
      </div>
      <div className="itinerary-actions">
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
          <details className="itinerary-more">
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
  copy: ReturnType<typeof itineraryCopy>;
  busy: boolean;
  locale: "zh-Hans" | "ja" | "en";
  onAccept: () => Promise<void>;
  onCheckIn: () => Promise<void>;
  onCorrection: () => Promise<void>;
}) {
  if (action.kind === "accept_offer") {
    return <div data-testid="itinerary-primary-action"><button type="button" disabled={busy} onClick={() => void onAccept()}>{copy.accept}</button></div>;
  }
  if (action.kind === "check_in") {
    return <div data-testid="itinerary-primary-action"><button type="button" disabled={busy} onClick={() => void onCheckIn()}>{copy.checkIn}</button></div>;
  }
  if (action.kind === "correct_attendance") {
    return <div data-testid="itinerary-primary-action"><button type="button" disabled={busy} onClick={() => void onCorrection()}>{copy.correction}</button></div>;
  }
  if (action.kind === "leave_feedback") {
    return <div data-testid="itinerary-primary-action"><EventFeedback registrationId={action.registrationId} locale={locale} /></div>;
  }
  if (action.kind === "view_status") {
    return <div data-testid="itinerary-primary-action"><Link href={`/me/events?registration=${action.registrationId}`}>{copy.viewStatus}</Link></div>;
  }
  if (action.kind === "open_event") {
    return <div data-testid="itinerary-primary-action"><Link href={`/e/${action.publicSlug}`}>{copy.open}</Link></div>;
  }
  return <div data-testid="itinerary-primary-action"><button type="button" disabled>{copy.unavailable}</button></div>;
}

function itineraryCopy(locale: "zh-Hans" | "ja" | "en") {
  if (locale === "ja") return {
    title: "参加予定", body: "申込状況と次に必要な操作を、サーバー時刻に基づいて表示します。", discover: "イベントを探す",
    refresh: "予定を更新", refreshing: "更新中…", loading: "参加予定を同期中…", empty: "この一覧にはイベントがありません",
    emptyBody: "申込やキャンセル待ちをすると、ここに表示されます。", unavailable: "イベントを表示できません", status: "申込状況",
    areaPending: "エリア確認中", partySize: "{count}人で参加", accept: "枠を受け取る", checkIn: "チェックイン", viewStatus: "状況を見る", open: "イベントを開く",
    more: "その他の操作", cancel: "申込をキャンセル", cancelConfirmation: "この申込をキャンセルしますか？条件を満たすポイントは自動で返還されます。",
    checkInCredential: "主催者の6桁コード、またはQRから取得したトークンを入力してください。", correction: "出席記録を修正",
    correctionPrompt: "出席したことが確認できる状況を入力してください（3文字以上）。", correctionSent: "出席記録の修正依頼を送信しました。主催者の確認をお待ちください。",
    tabs: { upcoming: "参加予定", waitlist: "キャンセル待ち", pending: "承認待ち", past: "過去" },
    statuses: { pending: "主催者の承認待ち", confirmed: "参加確定", waitlisted: "キャンセル待ち", offered: "枠を確保中・要確認" } as Record<string, string>,
  };
  if (locale === "en") return {
    title: "My events", body: "Your registration state and next action use authoritative server time.", discover: "Discover events",
    refresh: "Refresh itinerary", refreshing: "Refreshing…", loading: "Syncing registrations…", empty: "No events in this view",
    emptyBody: "Registrations and waitlists will appear here.", unavailable: "Event unavailable", status: "Registration status",
    areaPending: "Area to be confirmed", partySize: "Party of {count}", accept: "Accept spot", checkIn: "Check in", viewStatus: "View status", open: "Open event",
    more: "More actions", cancel: "Cancel registration", cancelConfirmation: "Cancel this registration? Eligible points will be refunded automatically.",
    checkInCredential: "Enter the host’s 6-digit code or a token from the QR code.", correction: "Correct attendance",
    correctionPrompt: "Describe why your attendance record should be corrected (at least 3 characters).", correctionSent: "Attendance correction sent. The host will review it.",
    tabs: { upcoming: "Upcoming", waitlist: "Waitlist", pending: "Pending", past: "Past" },
    statuses: { pending: "Awaiting host approval", confirmed: "Confirmed", waitlisted: "Waitlisted", offered: "Spot held—please confirm" } as Record<string, string>,
  };
  return {
    title: "我的活动", body: "报名状态与下一步操作以服务器时间为准。", discover: "发现更多",
    refresh: "更新行程", refreshing: "正在更新…", loading: "正在同步报名状态…", empty: "当前列表还没有活动",
    emptyBody: "报名或加入候补后会显示在这里。", unavailable: "活动暂不可见", status: "报名状态",
    areaPending: "区域待确认", partySize: "{count} 人参加", accept: "接受名额", checkIn: "现场签到", viewStatus: "查看状态", open: "打开活动",
    more: "更多操作", cancel: "取消报名", cancelConfirmation: "确定取消这次报名吗？符合规则的积分会自动退回。",
    checkInCredential: "请输入主办方提供的 6 位签到码，或粘贴二维码中的令牌。", correction: "申请补签",
    correctionPrompt: "请说明需要修正到场记录的原因（至少 3 个字）。", correctionSent: "补签申请已提交，等待主办方处理。",
    tabs: { upcoming: "即将开始", waitlist: "候补", pending: "待确认", past: "过去" },
    statuses: { pending: "等待主办方确认", confirmed: "已确认", waitlisted: "候补中", offered: "名额已保留，请确认" } as Record<string, string>,
  };
}
