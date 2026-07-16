"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { useI18n } from "../../components/I18nProvider";
import { APIError, apiRequest, errorMessage, readSession, type RegistrationView } from "../../lib/client-api";
import type { EventDetail } from "../../lib/event-contract";
import { resolveEventCTA } from "../../lib/event-cta";
import { fetchEvent } from "../../lib/events-api";
import {
  clearRegistrationDraft,
  gateDestination,
  loadRegistrationDraft,
  REGISTRATION_DRAFT_SCHEMA_VERSION,
  saveRegistrationDraft,
  type RegistrationAnswer,
  type RegistrationStep,
} from "../../lib/registration-draft";
import { RegistrationConfirmation } from "./RegistrationConfirmation";
import { DetailsForm, RegistrationUnavailable, ReviewForm } from "./RegistrationForms";
import styles from "./RegistrationFlow.module.css";
import {
  registrationPartyLimit,
  type RegistrationFieldErrors,
  type RegistrationQuote,
} from "./registration-model";

export { RegistrationConfirmation, registrationPartyLimit };

export function RegistrationFlow({
  event,
  navigate,
}: {
  event: EventDetail;
  navigate?: (destination: string) => void;
}) {
  const { t } = useI18n();
  const [liveEvent, setLiveEvent] = useState(event);
  const [gateReady, setGateReady] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [step, setStep] = useState<RegistrationStep>("details");
  const [partySize, setPartySize] = useState(1);
  const [answers, setAnswers] = useState<Record<string, RegistrationAnswer>>({});
  const [attendeeNote, setAttendeeNote] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(event.fee?.isFree ?? true);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [quote, setQuote] = useState<RegistrationQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [result, setResult] = useState<RegistrationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<RegistrationFieldErrors>({});
  const [needsReconfirmation, setNeedsReconfirmation] = useState(false);
  const [reconfirmed, setReconfirmed] = useState(false);
  const restoredOnce = useRef(false);
  const submitting = useRef(false);
  const draftVersions = useRef(new Set([event.version]));

  const full = liveEvent.capacity > 0 && liveEvent.availableCapacity === 0;
  const partyLimit = registrationPartyLimit(liveEvent);
  const registrationCTA = resolveEventCTA(liveEvent, {
    authenticated: ownerUserId !== null,
    phoneVerified: ownerUserId !== null,
  });

  useEffect(() => {
    if (restoredOnce.current) return;
    restoredOnce.current = true;
    const session = readSession();
    const currentOwnerUserId = session?.user.id ?? null;
    const stored = loadRegistrationDraft(window.sessionStorage, event.id, event.version, currentOwnerUserId);
    const key = stored?.idempotencyKey ?? window.crypto.randomUUID();
    setOwnerUserId(currentOwnerUserId);
    if (stored) {
      setPartySize(Math.min(stored.partySize, registrationPartyLimit(event)));
      setAnswers(stored.answers);
      setAttendeeNote(stored.attendeeNote);
      setAcceptedTerms(stored.acceptedTerms);
      setStep(stored.step);
    }
    setIdempotencyKey(key);
    const returnTo = `${window.location.pathname}${window.location.search}`;
    saveRegistrationDraft(window.sessionStorage, {
      ...(stored ?? {
        partySize: 1,
        answers: {},
        attendeeNote: "",
        acceptedTerms: event.fee?.isFree ?? true,
        step: "details",
        updatedAt: new Date().toISOString(),
      }),
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: event.id,
      eventVersion: event.version,
      ownerUserId: currentOwnerUserId,
      idempotencyKey: key,
    });
    const gate = gateDestination(readSession(), returnTo);
    if (gate) {
      (navigate ?? ((destination: string) => window.location.replace(destination)))(gate);
      return;
    }
    setGateReady(true);
    if (
      stored?.step === "review"
      && resolveEventCTA(event, { authenticated: true, phoneVerified: true }).intent === "register"
    ) {
      void requestFreshQuote(event.id).catch((error) => setMessage(errorMessage(error)));
    }
  }, [event, navigate]);

  useEffect(() => {
    if (!gateReady || !idempotencyKey || result) return;
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: liveEvent.id,
      eventVersion: liveEvent.version,
      ownerUserId,
      partySize,
      answers,
      attendeeNote,
      acceptedTerms,
      step,
      idempotencyKey,
      updatedAt: new Date().toISOString(),
    });
  }, [acceptedTerms, answers, attendeeNote, gateReady, idempotencyKey, liveEvent.id, liveEvent.version, ownerUserId, partySize, result, step]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--registration-keyboard-offset", `${inset}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--registration-keyboard-offset");
    };
  }, []);

  const requestQuote = useCallback(async (force = false) => {
    if (!force && quote && Date.parse(quote.expiresAt) > Date.now() + 5_000) return quote;
    setQuoteLoading(true);
    try {
      const next = await apiRequest<RegistrationQuote>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ purpose: "registration", resourceId: liveEvent.id }),
      });
      setQuote(next);
      return next;
    } finally {
      setQuoteLoading(false);
    }
  }, [liveEvent.id, quote]);

  function updateInput(update: () => void) {
    update();
    setQuote(null);
    setNeedsReconfirmation(false);
    setReconfirmed(false);
    setMessage("");
  }

  function validateDetails() {
    const errors: RegistrationFieldErrors = {};
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > partyLimit) {
      errors.partySize = t("registration.partySizeError", { count: partyLimit });
    }
    for (const question of liveEvent.registrationQuestions) {
      const answer = answers[question.id];
      if (question.required && (answer === undefined || answer === "")) {
        errors[`answers.${question.id}`] = t("registration.fieldRequired");
      }
    }
    if (liveEvent.fee && !liveEvent.fee.isFree && !acceptedTerms) {
      errors.acceptedTerms = t("registration.acceptError");
    }
    setFieldErrors(errors);
    const first = Object.keys(errors)[0];
    if (first) {
      setMessage(t("registration.checkErrors"));
      focusField(first);
      return false;
    }
    setMessage("");
    return true;
  }

  async function review(submission: FormEvent) {
    submission.preventDefault();
    if (!validateDetails()) return;
    setStep("review");
    try {
      await requestQuote();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function retryQuote() {
    setMessage("");
    try {
      await requestQuote(true);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function submitRegistration(submission: FormEvent) {
    submission.preventDefault();
    if (submitting.current) return;
    if (needsReconfirmation && !reconfirmed) {
      setMessage(t("registration.reconfirmRequired"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const activeQuote = await requestQuote();
      const registration = await apiRequest<RegistrationView>(`/events/${liveEvent.id}/registrations`, {
        method: "POST",
        authenticated: true,
        idempotencyKey,
        body: JSON.stringify({
          partySize,
          quoteId: activeQuote.id,
          joinWaitlistIfFull: full,
          attendeeNote: attendeeNote.trim() || undefined,
          answers,
        }),
      });
      clearLogicalDrafts();
      setResult(registration);
    } catch (error) {
      if (error instanceof APIError && error.body.fieldErrors?.length) {
        const errors = Object.fromEntries(error.body.fieldErrors.map((item) => [item.field, item.message]));
        setFieldErrors(errors);
        setStep("details");
        setMessage(t("registration.checkErrors"));
        focusField(error.body.fieldErrors[0]!.field);
      } else if (error instanceof APIError && error.status === 409) {
        await refreshAfterConflict();
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function refreshAfterConflict() {
    try {
      const session = readSession();
      const refreshed = await fetchEvent(liveEvent.id, session ? { accessToken: session.accessToken } : undefined);
      draftVersions.current.add(refreshed.version);
      setLiveEvent(refreshed);
      setPartySize((current) => Math.min(current, registrationPartyLimit(refreshed)));
      setQuote(null);
      setNeedsReconfirmation(true);
      setReconfirmed(false);
      setMessage(t("registration.changed"));
      await requestFreshQuote(refreshed.id);
    } catch (refreshError) {
      setMessage(errorMessage(refreshError));
    }
  }

  async function requestFreshQuote(eventId: string) {
    setQuoteLoading(true);
    try {
      const next = await apiRequest<RegistrationQuote>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ purpose: "registration", resourceId: eventId }),
      });
      setQuote(next);
    } finally {
      setQuoteLoading(false);
    }
  }

  function clearLogicalDrafts() {
    for (const version of draftVersions.current) {
      clearRegistrationDraft(window.sessionStorage, liveEvent.id, version);
    }
  }

  function restartRegistration() {
    clearLogicalDrafts();
    draftVersions.current = new Set([liveEvent.version]);
    setPartySize(1);
    setAnswers({});
    setAttendeeNote("");
    setAcceptedTerms(liveEvent.fee?.isFree ?? true);
    setStep("details");
    setIdempotencyKey(window.crypto.randomUUID());
    setQuote(null);
    setMessage("");
    setFieldErrors({});
    setNeedsReconfirmation(false);
    setReconfirmed(false);
  }

  function focusField(field: string) {
    window.setTimeout(() => {
      const id = field === "acceptedTerms"
        ? "registration-terms"
        : field.startsWith("answers.")
          ? `registration-answer-${field.slice("answers.".length)}`
          : `registration-${field}`;
      document.getElementById(id)?.focus();
    }, 0);
  }

  if (!gateReady) {
    return <main className={styles.page}><p className={styles.gateStatus} role="status">{t("registration.gateLoading")}</p></main>;
  }
  if (result) return <RegistrationConfirmation event={liveEvent} registration={result} />;
  if (registrationCTA.intent !== "register") return <RegistrationUnavailable event={liveEvent} />;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.wordmark} href="/discover">Spott</Link>
        <Link className={styles.back} href={`/e/${liveEvent.publicSlug}`}>← {t("registration.backEvent")}</Link>
      </header>
      <div className={styles.shell}>
        <div className={styles.progress} aria-label={t("registration.progress")}>
          <span aria-current={step === "details" ? "step" : undefined}>1</span>
          <i />
          <span aria-current={step === "review" ? "step" : undefined}>2</span>
        </div>
        {step === "details" ? (
          <DetailsForm
            event={liveEvent}
            partyLimit={partyLimit}
            partySize={partySize}
            answers={answers}
            attendeeNote={attendeeNote}
            acceptedTerms={acceptedTerms}
            fieldErrors={fieldErrors}
            message={message}
            onPartySize={(value) => updateInput(() => setPartySize(value))}
            onAnswer={(id, value) => updateInput(() => setAnswers((current) => ({ ...current, [id]: value })))}
            onNote={(value) => updateInput(() => setAttendeeNote(value))}
            onAccepted={(value) => updateInput(() => setAcceptedTerms(value))}
            onSubmit={review}
          />
        ) : (
          <ReviewForm
            event={liveEvent}
            partySize={partySize}
            answers={answers}
            attendeeNote={attendeeNote}
            quote={quote}
            quoteLoading={quoteLoading}
            busy={busy}
            message={message}
            needsReconfirmation={needsReconfirmation}
            reconfirmed={reconfirmed}
            onReconfirmed={setReconfirmed}
            onBack={() => setStep("details")}
            onRestart={restartRegistration}
            onRetryQuote={() => void retryQuote()}
            onSubmit={submitRegistration}
          />
        )}
      </div>
    </main>
  );
}
