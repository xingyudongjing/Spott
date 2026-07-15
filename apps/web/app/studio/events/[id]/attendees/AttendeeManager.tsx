"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppDialog } from "../../../../components/AppDialog";
import { useI18n } from "../../../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../../../lib/client-api";
import type { EventView } from "../../../../lib/demo-data";
import { StudioNav } from "../../../StudioNav";

type Status =
  | "pending"
  | "confirmed"
  | "waitlisted"
  | "offered"
  | "checked_in"
  | "cancelled"
  | "rejected"
  | "no_show";

interface AttendeeRegistration {
  id: string;
  eventId: string;
  status: Status;
  partySize: number;
  waitlistPosition?: number | null;
  attendeeNote?: string | null;
  answers: Record<string, unknown>;
  attendee: { id: string; nickname: string; publicHandle: string };
  createdAt?: string;
}

interface AttendeePage {
  items: AttendeeRegistration[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

interface CheckinCorrection {
  id: string;
  eventId: string;
  registration: {
    id: string;
    userId: string;
    status: string;
    partySize: number;
  };
  attendee: { id: string; nickname: string; publicHandle: string };
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

const statuses: Status[] = [
  "pending",
  "confirmed",
  "waitlisted",
  "offered",
  "checked_in",
  "cancelled",
  "rejected",
  "no_show",
];

export function AttendeeManager({ eventId }: { eventId: string }) {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const [event, setEvent] = useState<EventView | null>(null);
  const [items, setItems] = useState<AttendeeRegistration[]>([]);
  const [corrections, setCorrections] = useState<CheckinCorrection[]>([]);
  const [status, setStatus] = useState<Status>("pending");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(
    async (selected: Status, cursor?: string) => {
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setMessage("");
      try {
        const path = `/events/${eventId}/attendees?status=${selected}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const [eventValue, payload, correctionPage] = await Promise.all([
          event
            ? Promise.resolve(event)
            : apiRequest<EventView>(`/events/${eventId}`, { authenticated: true }),
          apiRequest<AttendeePage>(path, { authenticated: true }),
          cursor
            ? Promise.resolve(null)
            : apiRequest<{ items: CheckinCorrection[] }>(
                `/events/${eventId}/checkin-corrections?status=pending&limit=100`,
                { authenticated: true },
              ),
        ]);
        setEvent(eventValue);
        setItems((current) => (cursor ? [...current, ...payload.items] : payload.items));
        setNextCursor(payload.nextCursor ?? null);
        if (correctionPage) setCorrections(correctionPage.items);
      } catch (error) {
        setMessage(errorMessage(error));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [event, eventId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(status), 0);
    return () => window.clearTimeout(timer);
  }, [load, status]);

  const questionLabels = useMemo(
    () =>
      Object.fromEntries(
        (event?.registrationQuestions ?? [])
          .filter((question) => question.id)
          .map((question) => [question.id!, question.prompt]),
      ),
    [event],
  );

  async function decide(registration: AttendeeRegistration, decision: "approve" | "reject") {
    const applyDecision = async (reason?: string) => {
      setBusyId(registration.id);
      setMessage("");
      try {
        await apiRequest(`/registrations/${registration.id}/decision`, {
          method: "POST",
          authenticated: true,
          idempotent: true,
          body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
        });
        await load(status);
      } catch (error) {
        setMessage(errorMessage(error));
        if (decision === "reject") throw error;
      } finally {
        setBusyId("");
      }
    };
    if (decision === "approve") {
      await applyDecision();
      return;
    }
    const reasonLabel = locale === "ja"
      ? "却下理由（参加者に通知されます）"
      : locale === "en"
        ? "Reason for rejection (shared with the attendee)"
        : "拒绝原因（会通知参加者）";
    await appDialog.run({
      title: locale === "ja" ? "申込を却下" : locale === "en" ? "Reject registration" : "拒绝报名",
      confirmLabel: locale === "ja" ? "却下" : locale === "en" ? "Reject" : "确认拒绝",
      destructive: true,
      input: { label: reasonLabel, required: true, minLength: 1, multiline: true },
      onConfirm: applyDecision,
    });
  }

  async function checkIn(registration: AttendeeRegistration) {
    await appDialog.run({
      title: locale === "ja" ? "到着を記録" : locale === "en" ? "Record check-in" : "记录到场",
      message: locale === "ja"
        ? `${registration.attendee.nickname} を到着済みにしますか？`
        : locale === "en"
          ? `Mark ${registration.attendee.nickname} as checked in?`
          : `确认将 ${registration.attendee.nickname} 标记为已到场吗？`,
      confirmLabel: locale === "ja" ? "記録する" : locale === "en" ? "Mark checked in" : "确认到场",
      onConfirm: async () => {
        setBusyId(registration.id);
        setMessage("");
        try {
          await apiRequest(`/events/${eventId}/checkins/manual`, {
            method: "POST",
            authenticated: true,
            idempotent: true,
            body: JSON.stringify({
              registrationId: registration.id,
              operationId: window.crypto.randomUUID(),
              deviceRecordedAt: new Date().toISOString(),
            }),
          });
          await load(status);
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusyId("");
        }
      },
    });
  }

  async function decideCorrection(
    correction: CheckinCorrection,
    decision: "approve" | "reject",
  ) {
    const applyDecision = async (reason?: string) => {
      setBusyId(`correction:${correction.id}`);
      setMessage("");
      try {
        await apiRequest(`/checkin-corrections/${correction.id}/decision`, {
          method: "POST",
          authenticated: true,
          body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
        });
        setCorrections((current) => current.filter((item) => item.id !== correction.id));
        await load(status);
      } catch (error) {
        setMessage(errorMessage(error));
        throw error;
      } finally {
        setBusyId("");
      }
    };
    if (decision === "reject") {
      const reasonLabel = locale === "ja"
        ? "却下理由を入力してください（2文字以上）。参加者に記録されます。"
        : locale === "en"
          ? "Enter a reason for rejection (at least 2 characters). It will be recorded for the attendee."
          : "请输入拒绝补签的原因（至少 2 个字），该原因会记录给参加者。";
      await appDialog.run({
        title: locale === "ja" ? "修正依頼を却下" : locale === "en" ? "Reject correction" : "拒绝补签",
        confirmLabel: locale === "ja" ? "却下" : locale === "en" ? "Reject" : "确认拒绝",
        destructive: true,
        input: { label: reasonLabel, required: true, minLength: 2, multiline: true },
        onConfirm: applyDecision,
      });
      return;
    }
    await appDialog.run({
      title: locale === "ja" ? "出席を承認" : locale === "en" ? "Approve attendance" : "通过补签",
      message: locale === "ja"
        ? `${correction.attendee.nickname} の出席を承認し、チェックイン済みにしますか？`
        : locale === "en"
          ? `Approve ${correction.attendee.nickname}'s attendance and mark them checked in?`
          : `确认通过 ${correction.attendee.nickname} 的补签，并标记为已到场吗？`,
      confirmLabel: locale === "ja" ? "承認" : locale === "en" ? "Approve" : "确认通过",
      onConfirm: () => applyDecision(),
    });
  }

  const copy =
    locale === "ja"
      ? {
          title: "申込者とチェックイン",
          body: "承認、キャンセル待ち、参加状況は Web と iOS に同期されます。",
          empty: "この状態の申込はありません",
          note: "参加者メモ",
          answers: "申込回答",
          party: "人数",
          approve: "承認",
          reject: "却下",
          checkin: "到着を記録",
          corrections: "出席記録の修正依頼",
          correctionsBody: "イベント終了後48時間以内に参加者から届いた補足を確認します。",
          correctionReason: "参加者からの説明",
          correctionEmpty: "処理待ちの修正依頼はありません",
          approveCorrection: "出席を承認",
          rejectCorrection: "却下",
          more: "さらに表示",
        }
      : locale === "en"
        ? {
            title: "Attendees & check-in",
            body: "Approvals, waitlists, and attendance stay in sync across Web and iOS.",
            empty: "No registrations with this status",
            note: "Attendee note",
            answers: "Registration answers",
            party: "Party",
            approve: "Approve",
            reject: "Reject",
            checkin: "Check in",
            corrections: "Attendance corrections",
            correctionsBody: "Review post-event attendance evidence submitted within the 48-hour correction window.",
            correctionReason: "Attendee statement",
            correctionEmpty: "No attendance corrections are waiting",
            approveCorrection: "Approve attendance",
            rejectCorrection: "Reject",
            more: "Load more",
          }
        : {
            title: "报名与签到",
            body: "审核、候补与到场状态会同步到 Web 和 iOS。",
            empty: "当前状态没有报名",
            note: "参加者补充",
            answers: "报名回答",
            party: "人数",
            approve: "通过",
            reject: "拒绝",
            checkin: "确认到场",
            corrections: "补签申请",
            correctionsBody: "处理参加者在活动结束后 48 小时内提交的到场记录修正。",
            correctionReason: "参加者说明",
            correctionEmpty: "没有待处理的补签申请",
            approveCorrection: "通过补签",
            rejectCorrection: "拒绝",
            more: "加载更多",
          };

  return (
    <main className="studio-shell">
      <StudioNav current="events" />
      <section className="studio-content attendee-manager">
        <div className="dashboard-heading">
          <div>
            <Link className="back-link" href="/studio/events">
              ← {locale === "ja" ? "イベント管理" : locale === "en" ? "Events" : "活动管理"}
            </Link>
            <span className="section-number">HOST STUDIO / ATTENDEES</span>
            <h1>{copy.title}</h1>
            <p>{event ? `${event.title} · ${copy.body}` : copy.body}</p>
          </div>
        </div>
        <section className="correction-queue" aria-labelledby="correction-queue-title">
          <div className="correction-heading">
            <div>
              <span className="section-number">POST-EVENT / 48 HOURS</span>
              <h2 id="correction-queue-title">{copy.corrections}</h2>
              <p>{copy.correctionsBody}</p>
            </div>
            <strong>{corrections.length}</strong>
          </div>
          {corrections.length ? (
            <div className="correction-list">
              {corrections.map((correction) => (
                <article key={correction.id}>
                  <div className="attendee-avatar">
                    {Array.from(correction.attendee.nickname).slice(0, 1)}
                  </div>
                  <div>
                    <span>@{correction.attendee.publicHandle}</span>
                    <h3>{correction.attendee.nickname}</h3>
                    <small>
                      {copy.party}: {correction.registration.partySize} · {formatDate(correction.createdAt, locale)}
                    </small>
                    <blockquote>
                      <strong>{copy.correctionReason}</strong>
                      <p>{correction.reason}</p>
                    </blockquote>
                  </div>
                  <div className="attendee-actions">
                    <button
                      disabled={busyId === `correction:${correction.id}`}
                      onClick={() => void decideCorrection(correction, "approve")}
                    >
                      {copy.approveCorrection}
                    </button>
                    <button
                      className="danger-text"
                      disabled={busyId === `correction:${correction.id}`}
                      onClick={() => void decideCorrection(correction, "reject")}
                    >
                      {copy.rejectCorrection}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="correction-empty">✓ {copy.correctionEmpty}</p>
          )}
        </section>
        <div className="dashboard-tabs attendee-tabs">
          {statuses.map((value) => (
            <button
              key={value}
              className={status === value ? "active" : ""}
              onClick={() => setStatus(value)}
            >
              {statusLabel(value, locale)}
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
            <p>{t("common.loading")}</p>
          </div>
        ) : items.length ? (
          <>
            <div className="attendee-list">
              {items.map((item) => (
                <article key={item.id}>
                  <div className="attendee-avatar">
                    {Array.from(item.attendee.nickname).slice(0, 1)}
                  </div>
                  <div className="attendee-main">
                    <span>@{item.attendee.publicHandle}</span>
                    <h2>{item.attendee.nickname}</h2>
                    <p>
                      {copy.party}: {item.partySize}
                    </p>
                    {item.attendeeNote && (
                      <aside>
                        <strong>{copy.note}</strong>
                        <p>{item.attendeeNote}</p>
                      </aside>
                    )}
                    {Object.keys(item.answers ?? {}).length > 0 && (
                      <dl>
                        <dt>{copy.answers}</dt>
                        {Object.entries(item.answers).map(([questionId, answer]) => (
                          <div key={questionId}>
                            <dd>{questionLabels[questionId] ?? questionId}</dd>
                            <dd>{displayAnswer(answer)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                  <div className="attendee-actions">
                    <span className={`event-status status-${item.status}`}>
                      {statusLabel(item.status, locale)}
                    </span>
                    {item.status === "pending" && (
                      <>
                        <button
                          disabled={busyId === item.id}
                          onClick={() => void decide(item, "approve")}
                        >
                          {copy.approve}
                        </button>
                        <button
                          className="danger-text"
                          disabled={busyId === item.id}
                          onClick={() => void decide(item, "reject")}
                        >
                          {copy.reject}
                        </button>
                      </>
                    )}
                    {item.status === "confirmed" && (
                      <button
                        disabled={busyId === item.id}
                        onClick={() => void checkIn(item)}
                      >
                        {copy.checkin}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {nextCursor && (
              <button
                className="secondary-action compact list-more-action"
                disabled={loadingMore}
                onClick={() => void load(status, nextCursor)}
              >
                {loadingMore ? t("common.loading") : copy.more}
              </button>
            )}
          </>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
          </div>
        )}
      </section>
    </main>
  );
}

function displayAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function statusLabel(value: Status, locale: "zh-Hans" | "ja" | "en") {
  const labels: Record<Status, [string, string, string]> = {
    pending: ["待审核", "承認待ち", "Pending"],
    confirmed: ["已确认", "確定", "Confirmed"],
    waitlisted: ["候补", "キャンセル待ち", "Waitlisted"],
    offered: ["待接受名额", "枠を確保中", "Offer sent"],
    checked_in: ["已到场", "チェックイン済み", "Checked in"],
    cancelled: ["已取消", "キャンセル", "Cancelled"],
    rejected: ["未通过", "却下", "Rejected"],
    no_show: ["未到场", "欠席", "No-show"],
  };
  return labels[value][locale === "ja" ? 1 : locale === "en" ? 2 : 0];
}

function formatDate(value: string, locale: "zh-Hans" | "ja" | "en") {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
