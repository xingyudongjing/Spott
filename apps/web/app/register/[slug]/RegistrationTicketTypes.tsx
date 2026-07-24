"use client";

import { useI18n } from "../../components/I18nProvider";
import { formatMessage, type Locale } from "../../i18n/messages";
import styles from "./RegistrationFlow.module.css";
import type { EventTicketType, TicketTypesState } from "./registration-model";

/**
 * Ticket tier selection. Rendered only when the organizer published at least one
 * tier — an event without tiers keeps the single-fee flow exactly as it was.
 * Fees are pay-on-site records: this section never renders a payment form.
 */
export function RegistrationTicketTypes({
  state,
  selectedTicketTypeId,
  error,
  onSelect,
  onRetry,
}: {
  state: TicketTypesState;
  selectedTicketTypeId: string | null;
  error?: string;
  onSelect: (ticketTypeId: string) => void;
  onRetry: () => void;
}) {
  const { locale, t } = useI18n();

  if (state.kind === "loading" || state.kind === "idle") {
    return (
      <section className={styles.ticketSection} aria-busy={state.kind === "loading"}>
        <p className={styles.ticketLegend}>{t("ticket.section")}</p>
        <p className={styles.ticketStatus} role="status">{t("ticket.loading")}</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className={styles.ticketSection}>
        <p className={styles.ticketLegend}>{t("ticket.section")}</p>
        <p className={styles.ticketStatus} role="alert">{t("ticket.unavailable")}</p>
        <button className={styles.ticketRetry} type="button" onClick={onRetry}>{t("ticket.retry")}</button>
      </section>
    );
  }

  if (!state.items.length) return null;

  return (
    <fieldset className={styles.ticketSection}>
      <legend className={styles.ticketLegend}>{t("ticket.section")}</legend>
      <div className={styles.ticketList}>
        {state.items.map((ticket, index) => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            locale={locale}
            checked={selectedTicketTypeId === ticket.id}
            inputId={index === 0 ? "registration-ticketTypeId" : `registration-ticket-${ticket.id}`}
            invalid={Boolean(error)}
            onSelect={onSelect}
          />
        ))}
      </div>
      {error ? <small className={styles.fieldError} id="registration-error-ticketTypeId">{error}</small> : null}
      <small className={styles.ticketBoundary}>{t("ticket.boundary")}</small>
    </fieldset>
  );
}

function TicketRow({
  ticket,
  locale,
  checked,
  inputId,
  invalid,
  onSelect,
}: {
  ticket: EventTicketType;
  locale: Locale;
  checked: boolean;
  inputId: string;
  invalid: boolean;
  onSelect: (ticketTypeId: string) => void;
}) {
  const { t } = useI18n();
  const availability = ticket.soldOut
    ? t("ticket.soldOut")
    : ticket.remaining !== null && ticket.remaining <= 10
      ? t("ticket.remaining", { count: ticket.remaining })
      : ticket.quota !== null
        ? t("ticket.quota", { count: ticket.quota })
        : null;

  return (
    <label
      className={`${styles.ticketRow}${ticket.soldOut ? ` ${styles.ticketRowSoldOut}` : ""}`}
      htmlFor={inputId}
      data-selected={checked ? "true" : undefined}
    >
      <input
        id={inputId}
        type="radio"
        name="registration-ticketTypeId"
        value={ticket.id}
        checked={checked}
        disabled={ticket.soldOut}
        aria-describedby={invalid ? "registration-error-ticketTypeId" : undefined}
        onChange={() => onSelect(ticket.id)}
      />
      <span className={styles.ticketBody}>
        <strong>{ticket.name}</strong>
        {ticket.description ? <span className={styles.ticketDescription}>{ticket.description}</span> : null}
        {availability ? (
          <span className={ticket.soldOut ? styles.ticketSoldOut : styles.ticketAvailability}>{availability}</span>
        ) : null}
        {ticket.refundPolicy ? (
          <span className={styles.ticketTerms}>{t("ticket.refund")} · {ticket.refundPolicy}</span>
        ) : null}
      </span>
      <span className={styles.ticketPrice}>
        <strong>{ticketPriceLabel(ticket, locale)}</strong>
        {!ticket.isFree && ticket.amountJPY !== null ? <small>{t("ticket.payOnSite")}</small> : null}
      </span>
    </label>
  );
}

export function ticketPriceLabel(ticket: EventTicketType, locale: Locale): string {
  if (ticket.isFree) return formatMessage(locale, "common.free");
  if (ticket.amountJPY === null) return formatMessage(locale, "event.feeTBA");
  return new Intl.NumberFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
    { style: "currency", currency: "JPY", maximumFractionDigits: 0 },
  ).format(ticket.amountJPY);
}
