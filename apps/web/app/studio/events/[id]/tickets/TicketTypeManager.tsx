"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppDialog } from "../../../../components/AppDialog";
import { useI18n } from "../../../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../../../lib/client-api";
import { StudioNav } from "../../../StudioNav";
import { EventStudioHeader } from "../EventStudioHeader";
import { useOrganizerEvent } from "../use-organizer-event";

interface TicketTypeView {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  isFree: boolean;
  amountJPY: number | null;
  collectorName: string | null;
  method: string | null;
  paymentDeadlineText: string | null;
  refundPolicy: string | null;
  quota: number | null;
  soldCount: number;
  remaining: number | null;
  soldOut: boolean;
  active: boolean;
  sortOrder: number;
}

interface EditorState {
  id: string | null;
  name: string;
  description: string;
  isFree: boolean;
  amountJPY: string;
  collectorName: string;
  method: string;
  paymentDeadlineText: string;
  refundPolicy: string;
  quota: string;
  /** A paid tier can never become free again server-side; the toggle says so. */
  freeLocked: boolean;
  hadQuota: boolean;
}

const emptyEditor: EditorState = {
  id: null,
  name: "",
  description: "",
  isFree: true,
  amountJPY: "",
  collectorName: "",
  method: "",
  paymentDeadlineText: "",
  refundPolicy: "",
  quota: "",
  freeLocked: false,
  hadQuota: false,
};

export function TicketTypeManager({ eventId }: { eventId: string }) {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const { event, loading: eventLoading, error: eventError } = useOrganizerEvent(eventId);
  const [items, setItems] = useState<TicketTypeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiRequest<{ items: TicketTypeView[] }>(
        `/events/${eventId}/ticket-types`,
        { authenticated: true },
      );
      setItems(payload.items);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function startCreate() {
    setNotice("");
    setMessage("");
    setEditor({ ...emptyEditor });
  }

  function startEdit(item: TicketTypeView) {
    setNotice("");
    setMessage("");
    setEditor({
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      isFree: item.isFree,
      amountJPY: item.amountJPY ? String(item.amountJPY) : "",
      collectorName: item.collectorName ?? "",
      method: item.method ?? "",
      paymentDeadlineText: item.paymentDeadlineText ?? "",
      refundPolicy: item.refundPolicy ?? "",
      quota: item.quota ? String(item.quota) : "",
      freeLocked: !item.isFree,
      hadQuota: item.quota !== null,
    });
  }

  function updateEditor<K extends keyof EditorState>(key: K, value: EditorState[K]) {
    setEditor((current) => (current ? { ...current, [key]: value } : current));
  }

  async function saveEditor() {
    if (!editor) return;
    const name = editor.name.trim();
    if (name.length < 1 || name.length > 80) {
      setMessage(t("studio.tickets.nameError"));
      return;
    }
    const amount = Number(editor.amountJPY);
    if (
      !editor.isFree
      && (!Number.isInteger(amount)
        || amount <= 0
        || !editor.collectorName.trim()
        || !editor.method.trim()
        || !editor.refundPolicy.trim())
    ) {
      setMessage(t("studio.tickets.paidError"));
      return;
    }
    const quota = editor.quota.trim() ? Number(editor.quota) : null;
    if (
      (editor.quota.trim() && (!Number.isInteger(quota) || (quota ?? 0) < 1))
      || (editor.hadQuota && !editor.quota.trim())
    ) {
      setMessage(t("studio.tickets.quotaError"));
      return;
    }

    const body: Record<string, unknown> = { name, isFree: editor.isFree };
    if (editor.description.trim()) body.description = editor.description.trim();
    if (!editor.isFree) {
      body.amountJPY = amount;
      body.collectorName = editor.collectorName.trim();
      body.method = editor.method.trim();
      body.refundPolicy = editor.refundPolicy.trim();
      if (editor.paymentDeadlineText.trim()) {
        body.paymentDeadlineText = editor.paymentDeadlineText.trim();
      }
    }
    if (quota !== null) body.quota = quota;

    setBusy(true);
    setMessage("");
    try {
      if (editor.id) {
        await apiRequest(`/ticket-types/${editor.id}`, {
          method: "PATCH",
          authenticated: true,
          body: JSON.stringify(body),
        });
      } else {
        await apiRequest(`/events/${eventId}/ticket-types`, {
          method: "POST",
          authenticated: true,
          idempotent: true,
          body: JSON.stringify(body),
        });
      }
      setEditor(null);
      setNotice(t("studio.tickets.saved"));
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(item: TicketTypeView) {
    await appDialog.run({
      title: t("studio.tickets.deactivateTitle"),
      message: t("studio.tickets.deactivateBody"),
      confirmLabel: t("studio.tickets.deactivateConfirm"),
      destructive: true,
      onConfirm: async () => {
        setMessage("");
        try {
          await apiRequest(`/ticket-types/${item.id}`, {
            method: "PATCH",
            authenticated: true,
            body: JSON.stringify({ active: false }),
          });
          if (editor?.id === item.id) setEditor(null);
          await load();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  if (!eventLoading && !event) {
    return (
      <main className="studio-shell">
        <StudioNav current="events" />
        <section className="studio-content">
          <EventStudioHeader
            eventId={eventId}
            event={null}
            current="tickets"
            eyebrow="studio.eyebrow.tickets"
            title="studio.tickets.title"
            body="studio.tickets.body"
          />
          <div className="empty-state compact-empty">
            <h2>{t("studio.event.notFound")}</h2>
            <p>{eventError || t("studio.event.notFoundBody")}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="studio-shell">
      <StudioNav current="events" />
      <section className="studio-content">
        <EventStudioHeader
          eventId={eventId}
          event={event}
          current="tickets"
          eyebrow="studio.eyebrow.tickets"
          title="studio.tickets.title"
          body="studio.tickets.body"
        />
        <p className="studio-boundary-note">{t("studio.tickets.boundary")}</p>
        {(message || eventError) && (
          <p className="form-message" role="alert">
            {message || eventError}
          </p>
        )}
        {notice && (
          <p className="form-message" role="status">
            {notice}
          </p>
        )}

        {editor ? (
          <section className="management-card ticket-editor-card">
            <span className="section-number">
              {editor.id ? t("studio.tickets.editTitle") : t("studio.tickets.newTitle")}
            </span>
            <label className="form-field">
              {t("studio.tickets.name")}
              <input
                value={editor.name}
                maxLength={80}
                placeholder={t("studio.tickets.namePlaceholder")}
                onChange={(input) => updateEditor("name", input.target.value)}
              />
            </label>
            <label className="form-field">
              {t("studio.tickets.description")}
              <textarea
                rows={3}
                maxLength={500}
                value={editor.description}
                placeholder={t("studio.tickets.descriptionPlaceholder")}
                onChange={(input) => updateEditor("description", input.target.value)}
              />
            </label>
            <fieldset className="form-field">
              <legend>{t("studio.tickets.feeType")}</legend>
              <div className="choice-cards">
                <label className={editor.isFree ? "selected" : ""}>
                  <input
                    type="radio"
                    name="ticket-fee-type"
                    checked={editor.isFree}
                    disabled={editor.freeLocked}
                    onChange={() => updateEditor("isFree", true)}
                  />
                  <strong>{t("studio.tickets.free")}</strong>
                  {editor.freeLocked && <span>{t("studio.tickets.freeLocked")}</span>}
                </label>
                <label className={editor.isFree ? "" : "selected"}>
                  <input
                    type="radio"
                    name="ticket-fee-type"
                    checked={!editor.isFree}
                    onChange={() => updateEditor("isFree", false)}
                  />
                  <strong>{t("studio.tickets.paid")}</strong>
                </label>
              </div>
            </fieldset>
            {!editor.isFree && (
              <>
                <div className="form-grid">
                  <label className="form-field">
                    {t("studio.tickets.amount")}
                    <input
                      inputMode="numeric"
                      value={editor.amountJPY}
                      onChange={(input) =>
                        updateEditor("amountJPY", input.target.value.replace(/[^0-9]/g, ""))
                      }
                    />
                  </label>
                  <label className="form-field">
                    {t("studio.tickets.collector")}
                    <input
                      value={editor.collectorName}
                      maxLength={120}
                      onChange={(input) => updateEditor("collectorName", input.target.value)}
                    />
                  </label>
                  <label className="form-field">
                    {t("studio.tickets.method")}
                    <input
                      value={editor.method}
                      maxLength={120}
                      onChange={(input) => updateEditor("method", input.target.value)}
                    />
                  </label>
                  <label className="form-field">
                    {t("studio.tickets.deadline")}
                    <input
                      value={editor.paymentDeadlineText}
                      maxLength={240}
                      onChange={(input) => updateEditor("paymentDeadlineText", input.target.value)}
                    />
                  </label>
                </div>
                <label className="form-field">
                  {t("studio.tickets.refund")}
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={editor.refundPolicy}
                    onChange={(input) => updateEditor("refundPolicy", input.target.value)}
                  />
                </label>
              </>
            )}
            <label className="form-field">
              {t("studio.tickets.quota")}
              <input
                inputMode="numeric"
                value={editor.quota}
                onChange={(input) =>
                  updateEditor("quota", input.target.value.replace(/[^0-9]/g, ""))
                }
              />
              <small>{t("studio.tickets.quotaHint")}</small>
            </label>
            <div className="management-actions">
              <button className="primary-action compact" disabled={busy} onClick={() => void saveEditor()}>
                {busy ? t("studio.common.saving") : t("studio.common.save")}
              </button>
              <button disabled={busy} onClick={() => setEditor(null)}>
                {t("studio.common.cancel")}
              </button>
            </div>
          </section>
        ) : (
          <div className="studio-section-actions">
            <button className="primary-action compact" onClick={startCreate}>
              ＋ {t("studio.tickets.add")}
            </button>
          </div>
        )}

        {loading || eventLoading ? (
          <div className="loading-state">
            <span />
            <p>{t("common.loading")}</p>
          </div>
        ) : items.length ? (
          <div className="host-event-list">
            {items.map((item) => (
              <article key={item.id}>
                <div>
                  <span className="event-status">
                    {item.isFree
                      ? t("common.free")
                      : `¥${(item.amountJPY ?? 0).toLocaleString(intlLocale(locale))}`}
                  </span>
                  <h2>{item.name}</h2>
                  {item.description && <p>{item.description}</p>}
                  {!item.isFree && (
                    <p>
                      {[item.collectorName, item.method, item.paymentDeadlineText]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                <dl>
                  <div>
                    <dt>{t("studio.tickets.sold", { count: item.soldCount })}</dt>
                    <dd>
                      {item.soldOut
                        ? t("studio.tickets.soldOut")
                        : item.remaining === null
                          ? t("studio.tickets.quotaUnlimited")
                          : t("studio.tickets.remaining", { count: item.remaining })}
                    </dd>
                  </div>
                </dl>
                <div className="row-actions">
                  <button onClick={() => startEdit(item)}>{t("studio.tickets.edit")}</button>
                  <button className="danger-text" onClick={() => void deactivate(item)}>
                    {t("studio.tickets.deactivate")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{t("studio.tickets.empty")}</h2>
            <p>{t("studio.tickets.emptyBody")}</p>
          </div>
        )}
      </section>
    </main>
  );
}

function intlLocale(locale: "zh-Hans" | "ja" | "en"): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}
