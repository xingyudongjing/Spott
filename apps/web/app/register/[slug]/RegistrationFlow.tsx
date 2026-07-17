"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { useI18n } from "../../components/I18nProvider";
import { trackProductEvent } from "../../lib/analytics";
import {
  APIError,
  apiRequest,
  errorMessage,
  readSession,
  subscribeSessionChanges,
  type RegistrationView,
} from "../../lib/client-api";
import type { EventDetail } from "../../lib/event-contract";
import { resolveEventCTA } from "../../lib/event-cta";
import { fetchViewerEvent } from "../../lib/events-client";
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
import { RegistrationHeader } from "./RegistrationHeader";
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
  const [gateError, setGateError] = useState(false);
  const [gateAttempt, setGateAttempt] = useState(0);
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
  const ownerUserIdRef = useRef<string | null>(null);
  const operationGeneration = useRef(0);

  const full = liveEvent.capacity > 0 && liveEvent.availableCapacity === 0;
  const partyLimit = registrationPartyLimit(liveEvent);
  const registrationCTA = resolveEventCTA(liveEvent, {
    authenticated: ownerUserId !== null,
    phoneVerified: ownerUserId !== null,
  });

  const invalidateForOwnerChange = useCallback(() => {
    const nextOwnerUserId = readSession()?.user.id ?? null;
    if (nextOwnerUserId === ownerUserIdRef.current) return;
    operationGeneration.current += 1;
    submitting.current = false;
    restoredOnce.current = false;
    ownerUserIdRef.current = null;
    draftVersions.current = new Set([event.version]);
    setOwnerUserId(null);
    setLiveEvent(event);
    setGateReady(false);
    setGateError(false);
    setStep("details");
    setPartySize(1);
    setAnswers({});
    setAttendeeNote("");
    setAcceptedTerms(event.fee?.isFree ?? true);
    setIdempotencyKey("");
    setQuote(null);
    setQuoteLoading(false);
    setResult(null);
    setBusy(false);
    setMessage("");
    setFieldErrors({});
    setNeedsReconfirmation(false);
    setReconfirmed(false);
    setGateAttempt((current) => current + 1);
  }, [event]);

  const captureOwnerOperation = useCallback(() => {
    const session = readSession();
    const owner = ownerUserIdRef.current;
    if (!session || !owner || session.user.id !== owner) {
      invalidateForOwnerChange();
      return null;
    }
    return { generation: operationGeneration.current, userId: owner };
  }, [invalidateForOwnerChange]);

  const isOwnerOperationCurrent = useCallback((operation: { generation: number; userId: string }) => {
    const session = readSession();
    return operation.generation === operationGeneration.current
      && ownerUserIdRef.current === operation.userId
      && session?.user.id === operation.userId;
  }, []);

  const requestFreshQuote = useCallback(async (eventId: string) => {
    const operation = captureOwnerOperation();
    if (!operation) return null;
    setQuoteLoading(true);
    try {
      const next = await apiRequest<RegistrationQuote>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ purpose: "registration", resourceId: eventId }),
      });
      if (!isOwnerOperationCurrent(operation)) return null;
      setQuote(next);
      return next;
    } finally {
      if (isOwnerOperationCurrent(operation)) setQuoteLoading(false);
    }
  }, [captureOwnerOperation, isOwnerOperationCurrent]);

  useEffect(() => {
    if (restoredOnce.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        restoredOnce.current = true;
        setGateError(false);
        const session = readSession();
        const currentOwnerUserId = session?.user.id ?? null;
        ownerUserIdRef.current = currentOwnerUserId;
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
        const gate = gateDestination(session, returnTo);
        if (gate) {
          (navigate ?? ((destination: string) => window.location.replace(destination)))(gate);
          return;
        }

        let authorizedEvent: EventDetail;
        try {
          authorizedEvent = await fetchViewerEvent(event.id);
        } catch (error) {
          if (
            !cancelled
            && ownerUserIdRef.current === currentOwnerUserId
            && readSession()?.user.id === currentOwnerUserId
          ) {
            setMessage(errorMessage(error));
            setGateError(true);
            setGateReady(false);
          }
          return;
        }
        if (
          cancelled
          || ownerUserIdRef.current !== currentOwnerUserId
          || readSession()?.user.id !== currentOwnerUserId
        ) return;
        draftVersions.current.add(authorizedEvent.version);
        setLiveEvent(authorizedEvent);
        setPartySize((current) => Math.min(current, registrationPartyLimit(authorizedEvent)));
        setAnswers((current) => answersForEvent(authorizedEvent, current));
        if (registrationFeeTermsChanged(event, authorizedEvent)) {
          setAcceptedTerms(authorizedEvent.fee?.isFree ?? true);
        }

        if (cancelled) return;
        setGateReady(true);
        if (
          stored?.step === "review"
          && resolveEventCTA(authorizedEvent, { authenticated: true, phoneVerified: true }).intent === "register"
        ) {
          void requestFreshQuote(authorizedEvent.id).catch((error) => setMessage(errorMessage(error)));
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [event, gateAttempt, navigate, requestFreshQuote]);

  useEffect(() => subscribeSessionChanges(invalidateForOwnerChange), [invalidateForOwnerChange]);

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
    const operation = captureOwnerOperation();
    if (!operation) return null;
    if (!force && quote && Date.parse(quote.expiresAt) > Date.now() + 5_000) return quote;
    setQuoteLoading(true);
    try {
      const next = await apiRequest<RegistrationQuote>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ purpose: "registration", resourceId: liveEvent.id }),
      });
      if (!isOwnerOperationCurrent(operation)) return null;
      setQuote(next);
      return next;
    } finally {
      if (isOwnerOperationCurrent(operation)) setQuoteLoading(false);
    }
  }, [captureOwnerOperation, isOwnerOperationCurrent, liveEvent.id, quote]);

  function updateInput(update: () => void) {
    update();
    setQuote(null);
    setNeedsReconfirmation(false);
    setReconfirmed(false);
    setMessage("");
  }

  function detailValidationErrors(
    candidateEvent: EventDetail,
    candidatePartySize: number,
    candidateAcceptedTerms: boolean,
    candidateAnswers: Record<string, RegistrationAnswer>,
  ) {
    const errors: RegistrationFieldErrors = {};
    const candidatePartyLimit = registrationPartyLimit(candidateEvent);
    if (
      !Number.isInteger(candidatePartySize)
      || candidatePartySize < 1
      || candidatePartySize > candidatePartyLimit
    ) {
      errors.partySize = t("registration.partySizeError", { count: candidatePartyLimit });
    }
    for (const question of candidateEvent.registrationQuestions) {
      const answer = candidateAnswers[question.id];
      if (question.required && (answer === undefined || answer === "")) {
        errors[`answers.${question.id}`] = t("registration.fieldRequired");
      }
    }
    if (candidateEvent.fee && !candidateEvent.fee.isFree && !candidateAcceptedTerms) {
      errors.acceptedTerms = t("registration.acceptError");
    }
    return errors;
  }

  function validateDetails() {
    const errors = detailValidationErrors(liveEvent, partySize, acceptedTerms, answers);
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
    if (!captureOwnerOperation()) return;
    if (!validateDetails()) return;
    setStep("review");
    try {
      await requestQuote();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function retryQuote() {
    if (!captureOwnerOperation()) return;
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
    const operation = captureOwnerOperation();
    if (!operation) return;
    if (needsReconfirmation && !reconfirmed) {
      setMessage(t("registration.reconfirmRequired"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const activeQuote = await requestQuote();
      if (!activeQuote || !isOwnerOperationCurrent(operation)) return;
      const registration = await apiRequest<RegistrationView>(`/events/${liveEvent.id}/registrations`, {
        method: "POST",
        authenticated: true,
        idempotencyKey,
        body: JSON.stringify({
          partySize,
          quoteId: activeQuote.id,
          expectedEventVersion: liveEvent.version,
          joinWaitlistIfFull: full,
          attendeeNote: attendeeNote.trim() || undefined,
          answers,
        }),
      });
      if (!isOwnerOperationCurrent(operation)) return;
      void trackProductEvent("registration_completed", {
        eventId: liveEvent.id,
        registrationStatus: registration.status,
        partySize: registration.partySize,
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
      if (isOwnerOperationCurrent(operation)) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  async function refreshAfterConflict() {
    const operation = captureOwnerOperation();
    if (!operation) return;
    try {
      const refreshed = await fetchViewerEvent(liveEvent.id);
      if (!isOwnerOperationCurrent(operation)) return;
      const nextPartySize = Math.min(partySize, registrationPartyLimit(refreshed));
      const feeTermsChanged = registrationFeeTermsChanged(liveEvent, refreshed);
      const nextAcceptedTerms = feeTermsChanged
        ? refreshed.fee?.isFree ?? true
        : acceptedTerms;
      const nextAnswers = answersForEvent(refreshed, answers);
      const errors = detailValidationErrors(
        refreshed,
        nextPartySize,
        nextAcceptedTerms,
        nextAnswers,
      );
      const firstInvalidField = Object.keys(errors)[0];
      const requiresDetails = feeTermsChanged || Boolean(firstInvalidField);
      draftVersions.current.add(refreshed.version);
      setLiveEvent(refreshed);
      setPartySize(nextPartySize);
      setAnswers(nextAnswers);
      setAcceptedTerms(nextAcceptedTerms);
      setFieldErrors(errors);
      setQuote(null);
      setNeedsReconfirmation(true);
      setReconfirmed(false);
      setMessage(t("registration.changed"));
      if (requiresDetails) {
        setStep("details");
        if (firstInvalidField) focusField(firstInvalidField);
        return;
      }
      await requestFreshQuote(refreshed.id);
    } catch (refreshError) {
      if (isOwnerOperationCurrent(operation)) setMessage(errorMessage(refreshError));
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

  function retryGate() {
    restoredOnce.current = false;
    setGateError(false);
    setGateReady(false);
    setMessage("");
    setGateAttempt((current) => current + 1);
  }

  if (gateError) {
    return (
      <main className={styles.page}>
        <RegistrationHeader eventSlug={liveEvent.publicSlug} />
        <section className={styles.unavailable}>
          <p className={styles.eyebrow}>{t("registration.completeStep")}</p>
          <h1>{t("registration.loadErrorTitle")}</h1>
          <p>{t("registration.loadErrorBody")}</p>
          {message ? <p className={styles.gateErrorDetail} role="alert">{message}</p> : null}
          <button className={styles.confirmationPrimary} type="button" onClick={retryGate}>{t("common.retry")}</button>
        </section>
      </main>
    );
  }
  if (!gateReady) {
    return (
      <main className={styles.page}>
        <RegistrationHeader eventSlug={liveEvent.publicSlug} />
        <p className={styles.gateStatus} role="status">{t("registration.gateLoading")}</p>
      </main>
    );
  }
  if (result) return <RegistrationConfirmation event={liveEvent} registration={result} />;
  if (registrationCTA.intent !== "register") return <RegistrationUnavailable event={liveEvent} />;

  return (
    <main className={styles.page}>
      <RegistrationHeader eventSlug={liveEvent.publicSlug} />
      <div className={styles.shell}>
        <ol className={styles.progress} aria-label={t("registration.progress")}>
          <li aria-current={step === "details" ? "step" : undefined}>
            <span aria-hidden="true">1</span>
            <span className="sr-only">{t("registration.detailsStep")}</span>
          </li>
          <li className={styles.progressConnector} aria-hidden="true" />
          <li aria-current={step === "review" ? "step" : undefined}>
            <span aria-hidden="true">2</span>
            <span className="sr-only">{t("registration.reviewStep")}</span>
          </li>
        </ol>
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

function registrationFeeTermsChanged(previous: EventDetail, next: EventDetail) {
  const previousFee = previous.fee;
  const nextFee = next.fee;
  return previousFee?.isFree !== nextFee?.isFree
    || previousFee?.amountJPY !== nextFee?.amountJPY
    || previousFee?.collectorName !== nextFee?.collectorName
    || previousFee?.method !== nextFee?.method
    || previousFee?.paymentDeadlineText !== nextFee?.paymentDeadlineText
    || previousFee?.refundPolicy !== nextFee?.refundPolicy;
}

function answersForEvent(
  event: EventDetail,
  answers: Record<string, RegistrationAnswer>,
) {
  const liveQuestionIds = new Set(event.registrationQuestions.map((question) => question.id));
  return Object.fromEntries(
    Object.entries(answers).filter(([questionId]) => liveQuestionIds.has(questionId)),
  ) as Record<string, RegistrationAnswer>;
}
