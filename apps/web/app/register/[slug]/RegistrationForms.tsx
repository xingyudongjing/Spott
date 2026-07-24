"use client";

import Link from "next/link";
import type { FormEvent } from "react";

import { useI18n } from "../../components/I18nProvider";
import type { EventDetail } from "../../lib/event-contract";
import { eventDate, eventFeeLabel, eventTime } from "../../lib/format";
import type { RegistrationAnswer } from "../../lib/registration-draft";
import styles from "./RegistrationFlow.module.css";
import { RegistrationHeader } from "./RegistrationHeader";
import { RegistrationTicketTypes, ticketPriceLabel } from "./RegistrationTicketTypes";
import type {
  EventTicketType,
  RegistrationFieldErrors,
  RegistrationQuote,
  TicketTypesState,
} from "./registration-model";

export function RegistrationUnavailable({ event }: { event: EventDetail }) {
  const { t } = useI18n();
  return (
    <main className={styles.page}>
      <RegistrationHeader eventSlug={event.publicSlug} />
      <section className={styles.unavailable}>
        <p className={styles.eyebrow}>{t("registration.completeStep")}</p>
        <h1>{t("registration.unavailableTitle")}</h1>
        <p>{t("registration.unavailableBody")}</p>
        <EventSummary event={event} />
        <Link className={styles.confirmationPrimary} href={`/e/${event.publicSlug}`}>{t("registration.backEvent")}</Link>
      </section>
    </main>
  );
}

export function DetailsForm({
  event,
  partyLimit,
  partySize,
  answers,
  attendeeNote,
  acceptedTerms,
  fieldErrors,
  message,
  ticketTypes,
  ticketTypeId,
  onTicketType,
  onRetryTicketTypes,
  onPartySize,
  onAnswer,
  onNote,
  onAccepted,
  onSubmit,
}: {
  event: EventDetail;
  partyLimit: number;
  partySize: number;
  answers: Record<string, RegistrationAnswer>;
  attendeeNote: string;
  acceptedTerms: boolean;
  fieldErrors: RegistrationFieldErrors;
  message: string;
  ticketTypes: TicketTypesState;
  ticketTypeId: string | null;
  onTicketType: (value: string) => void;
  onRetryTicketTypes: () => void;
  onPartySize: (value: number) => void;
  onAnswer: (id: string, value: RegistrationAnswer) => void;
  onNote: (value: string) => void;
  onAccepted: (value: boolean) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { locale, t } = useI18n();
  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <section className={styles.formBody}>
        <p className={styles.eyebrow}>{t("registration.detailsStep")}</p>
        <h1>{t(event.availableCapacity === 0 ? "registration.waitlistTitle" : "registration.title")}</h1>
        <EventSummary event={event} />
        <RegistrationTicketTypes
          state={ticketTypes}
          selectedTicketTypeId={ticketTypeId}
          error={fieldErrors.ticketTypeId}
          onSelect={onTicketType}
          onRetry={onRetryTicketTypes}
        />
        <label className={styles.field} htmlFor="registration-partySize">
          <span>{t("registration.partySize")}</span>
          <input
            id="registration-partySize"
            type="number"
            inputMode="numeric"
            min={1}
            max={partyLimit}
            value={partySize}
            aria-invalid={Boolean(fieldErrors.partySize)}
            aria-describedby={fieldErrors.partySize ? "registration-error-partySize" : "registration-limit-partySize"}
            onChange={(input) => onPartySize(Math.min(partyLimit, Math.max(1, Number(input.target.value) || 1)))}
          />
          <small id="registration-limit-partySize">{t("registration.partyLimit", { count: partyLimit })}</small>
          {fieldErrors.partySize ? <small className={styles.fieldError} id="registration-error-partySize">{fieldErrors.partySize}</small> : null}
        </label>
        {event.attendeeRequirements ? (
          <aside className={styles.requirements}><strong>{t("detail.requirements")}</strong><p>{event.attendeeRequirements}</p></aside>
        ) : null}
        {event.registrationQuestions.length ? (
          <fieldset className={styles.questions}>
            <legend>{t("registration.questions")}</legend>
            {event.registrationQuestions.map((question) => {
              const key = `answers.${question.id}`;
              const errorId = `registration-error-${question.id}`;
              const inputId = `registration-answer-${question.id}`;
              return (
                <label className={styles.field} htmlFor={inputId} key={question.id}>
                  <span>{question.prompt} {question.required ? <em>{t("registration.required")}</em> : null}</span>
                  {question.kind === "single_choice" ? (
                    <select
                      id={inputId}
                      value={String(answers[question.id] ?? "")}
                      aria-invalid={Boolean(fieldErrors[key])}
                      aria-describedby={fieldErrors[key] ? errorId : undefined}
                      onChange={(input) => onAnswer(question.id, input.target.value)}
                    >
                      <option value="">{t("registration.select")}</option>
                      {question.options.map((option) => <option value={option} key={option}>{option}</option>)}
                    </select>
                  ) : question.kind === "boolean" ? (
                    <select
                      id={inputId}
                      value={answers[question.id] === undefined ? "" : String(answers[question.id])}
                      aria-invalid={Boolean(fieldErrors[key])}
                      aria-describedby={fieldErrors[key] ? errorId : undefined}
                      onChange={(input) => onAnswer(question.id, input.target.value === "true")}
                    >
                      <option value="">{t("registration.select")}</option>
                      <option value="true">{t("registration.yes")}</option>
                      <option value="false">{t("registration.no")}</option>
                    </select>
                  ) : (
                    <textarea
                      id={inputId}
                      maxLength={1000}
                      value={String(answers[question.id] ?? "")}
                      aria-invalid={Boolean(fieldErrors[key])}
                      aria-describedby={fieldErrors[key] ? errorId : undefined}
                      onChange={(input) => onAnswer(question.id, input.target.value)}
                    />
                  )}
                  {fieldErrors[key] ? <small className={styles.fieldError} id={errorId}>{fieldErrors[key]}</small> : null}
                </label>
              );
            })}
          </fieldset>
        ) : null}
        <label className={styles.field} htmlFor="registration-attendeeNote">
          <span>{t("registration.note")}</span>
          <textarea id="registration-attendeeNote" maxLength={1000} value={attendeeNote} placeholder={t("registration.notePlaceholder")} onChange={(input) => onNote(input.target.value)} />
        </label>
        {event.fee && !event.fee.isFree ? (
          <label className={styles.terms} htmlFor="registration-terms">
            <input
              id="registration-terms"
              type="checkbox"
              checked={acceptedTerms}
              aria-invalid={Boolean(fieldErrors.acceptedTerms)}
              aria-describedby={fieldErrors.acceptedTerms ? "registration-error-terms" : undefined}
              onChange={(input) => onAccepted(input.target.checked)}
            />
            <span>
              <strong>{t("registration.acceptFee")}</strong>
              <small>{feeTerms(event, locale)}</small>
              {fieldErrors.acceptedTerms ? <em id="registration-error-terms">{fieldErrors.acceptedTerms}</em> : null}
            </span>
          </label>
        ) : null}
        <RegistrationLegalConsent />
      </section>
      <SubmitBar message={message} label={t("registration.review")} />
    </form>
  );
}

function RegistrationLegalConsent() {
  const { t } = useI18n();
  const newWindowLabel = t("registration.opensNewWindow");
  return (
    <p className={styles.legalConsent}>
      {t("registration.legalBeforeTerms")}
      <Link href="/terms" target="_blank" rel="noopener noreferrer">
        {t("registration.legalTerms")}
        <span className="sr-only"> ({newWindowLabel})</span>
        <ExternalLinkIcon />
      </Link>
      {t("registration.legalBetween")}
      <Link href="/privacy" target="_blank" rel="noopener noreferrer">
        {t("registration.legalPrivacy")}
        <span className="sr-only"> ({newWindowLabel})</span>
        <ExternalLinkIcon />
      </Link>
      {t("registration.legalAfterPrivacy")}
    </p>
  );
}

function ExternalLinkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none">
      <path d="M6 3h7v7M13 3 5.5 10.5M11 9.5V13H3V5h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReviewForm({
  event,
  partySize,
  answers,
  attendeeNote,
  ticketType,
  quote,
  quoteLoading,
  busy,
  message,
  needsReconfirmation,
  reconfirmed,
  onReconfirmed,
  onBack,
  onRestart,
  onRetryQuote,
  onSubmit,
}: {
  event: EventDetail;
  partySize: number;
  answers: Record<string, RegistrationAnswer>;
  attendeeNote: string;
  ticketType: EventTicketType | null;
  quote: RegistrationQuote | null;
  quoteLoading: boolean;
  busy: boolean;
  message: string;
  needsReconfirmation: boolean;
  reconfirmed: boolean;
  onReconfirmed: (value: boolean) => void;
  onBack: () => void;
  onRestart: () => void;
  onRetryQuote: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { locale, t } = useI18n();
  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <section className={styles.formBody}>
        <p className={styles.eyebrow}>{t("registration.reviewStep")}</p>
        <h1>{t("registration.reviewTitle")}</h1>
        <EventSummary event={event} />
        {needsReconfirmation ? (
          <aside className={styles.changed}>
            <strong>{t("registration.changed")}</strong>
            <p>{t("registration.changedBody")}</p>
          </aside>
        ) : null}
        <dl className={styles.reviewList}>
          {ticketType ? (
            <div>
              <dt>{t("ticket.selection")}</dt>
              <dd>
                {ticketType.name} · {ticketPriceLabel(ticketType, locale)}
                {!ticketType.isFree && ticketType.amountJPY !== null ? ` · ${t("ticket.payOnSite")}` : ""}
              </dd>
            </div>
          ) : null}
          <div><dt>{t("registration.partySize")}</dt><dd>{t("registration.partySummary", { count: partySize })}</dd></div>
          {event.registrationQuestions.map((question) => answers[question.id] !== undefined ? (
            <div key={question.id}><dt>{question.prompt}</dt><dd>{String(answers[question.id])}</dd></div>
          ) : null)}
          {attendeeNote ? <div><dt>{t("registration.note")}</dt><dd>{attendeeNote}</dd></div> : null}
        </dl>
        <section className={styles.quote} aria-live="polite">
          <span>{t("registration.points")}</span>
          <strong>{quoteLoading ? t("registration.quoteLoading") : quote ? t("registration.pointsAmount", { count: quote.amount }) : t("registration.quoteUnavailable")}</strong>
          <p>{t("registration.pointsBoundary")}</p>
          {!quote && !quoteLoading ? (
            <button className={styles.quoteRetry} type="button" onClick={onRetryQuote}>{t("registration.retryQuote")}</button>
          ) : null}
        </section>
        {needsReconfirmation ? (
          <label className={styles.reconfirm}>
            <input type="checkbox" checked={reconfirmed} onChange={(input) => onReconfirmed(input.target.checked)} />
            <span>{t("registration.reconfirm")}</span>
          </label>
        ) : null}
        <div className={styles.reviewUtilities}>
          <button className={styles.edit} type="button" disabled={busy} onClick={onBack}>{t("registration.edit")}</button>
          <button className={styles.restart} type="button" disabled={busy} onClick={onRestart}>{t("registration.restart")}</button>
        </div>
      </section>
      <SubmitBar
        message={message}
        label={busy ? t("registration.submitting") : t(event.availableCapacity === 0 ? "registration.submitWaitlist" : "registration.submit")}
        disabled={busy || quoteLoading || !quote}
      />
    </form>
  );
}

function SubmitBar({ message, label, disabled = false }: { message: string; label: string; disabled?: boolean }) {
  return (
    <div className={styles.submitBar}>
      {message ? <p role="alert">{message}</p> : <span />}
      <button type="submit" disabled={disabled}>{label}</button>
    </div>
  );
}

export function EventSummary({ event }: { event: EventDetail }) {
  const { locale, t } = useI18n();
  const location = event.format === "online"
    ? t("detail.online")
    : event.publicArea ?? t("event.areaTBA");
  return (
    <aside className={styles.eventSummary}>
      <div>
        <strong>{event.title}</strong>
        <p>{eventDate(event.startsAt, locale, event.displayTimeZone)} · {eventTime(event.startsAt, event.endsAt, locale, event.displayTimeZone)}</p>
        <p>{location}</p>
      </div>
      <span>{eventFeeLabel(event.fee, locale)}</span>
    </aside>
  );
}

function feeTerms(event: EventDetail, locale: "zh-Hans" | "ja" | "en") {
  const terms = [event.fee?.collectorName, event.fee?.method, event.fee?.paymentDeadlineText, event.fee?.refundPolicy].filter(Boolean);
  return terms.length ? terms.join(" · ") : eventFeeLabel(event.fee, locale);
}
