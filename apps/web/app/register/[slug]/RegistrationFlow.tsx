'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { EventView } from '../../lib/demo-data';
import { eventDate, eventTime } from '../../lib/format';
import { trackProductEvent } from '../../lib/analytics';
import { apiRequest, errorMessage, readSession, type RegistrationView } from '../../lib/client-api';
import { useI18n } from '../../components/I18nProvider';

interface Quote {
  id: string;
  amount: number;
  currency: 'POINTS';
  expiresAt: string;
}

export function RegistrationFlow({ event }: { event: EventView }) {
  const { locale, t } = useI18n();
  const [accepted, setAccepted] = useState(event.fee?.isFree ?? false);
  const [partySize, setPartySize] = useState(1);
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [attendeeNote, setAttendeeNote] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [result, setResult] = useState<RegistrationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const full = event.capacity > 0 && event.confirmedCount >= event.capacity;

  useEffect(() => {
    const session = readSession();
    const path = `/register/${event.publicSlug}`;
    if (!session) window.location.replace(`/login?returnTo=${encodeURIComponent(path)}`);
    else if (!session.user.phoneVerified)
      window.location.replace(`/phone-verification?returnTo=${encodeURIComponent(path)}`);
  }, [event.publicSlug]);

  async function submit(eventSubmit: FormEvent) {
    eventSubmit.preventDefault();
    if (!accepted) {
      setMessage('请先确认已阅读线下费用与退款边界。');
      return;
    }
    const missingQuestion = (event.registrationQuestions ?? []).find(
      (question) =>
        question.required &&
        question.id &&
        (answers[question.id] === undefined || answers[question.id] === ''),
    );
    if (missingQuestion) {
      setMessage(
        locale === 'ja'
          ? `必須項目に回答してください：${missingQuestion.prompt}`
          : locale === 'en'
            ? `Please answer: ${missingQuestion.prompt}`
            : `请回答必填问题：${missingQuestion.prompt}`,
      );
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const activeQuote =
        quote ??
        (await apiRequest<Quote>('/quotes', {
          method: 'POST',
          authenticated: true,
          body: JSON.stringify({ purpose: 'registration', resourceId: event.id }),
        }));
      setQuote(activeQuote);
      const registration = await apiRequest<RegistrationView>(`/events/${event.id}/registrations`, {
        method: 'POST',
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({
          partySize,
          quoteId: activeQuote.id,
          joinWaitlistIfFull: full,
          attendeeNote: attendeeNote.trim() || undefined,
          answers: Object.fromEntries(
            Object.entries(answers).filter(([id]) => /^[0-9a-f-]{36}$/i.test(id)),
          ),
        }),
      });
      setResult(registration);
      void trackProductEvent('registration_completed', {
        eventId: event.id,
        status: registration.status,
        partySize,
        waitlisted: registration.status === 'waitlisted',
      });
    } catch (error) {
      setQuote(null);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const waiting = result.status === 'waitlisted';
    return (
      <main className="flow-page">
        <div className="flow-shell narrow">
          <section className="flow-card success-card">
            <span className="success-mark" aria-hidden="true">
              ✓
            </span>
            <span className="section-number">REGISTRATION / COMPLETE</span>
            <h1>{waiting ? t('registration.waitlistSuccess') : t('registration.success')}</h1>
            <p className="lead">
              {waiting
                ? locale === 'ja'
                  ? '空席が出たら Web と iOS の両方でお知らせします。'
                  : locale === 'en'
                    ? 'We’ll notify you on Web and iOS when a spot opens.'
                    : '有名额释放时，我们会同时在 Web 和 iOS 通知你。'
                : locale === 'ja'
                  ? 'Web と iOS の「参加予定」に追加されました。'
                  : locale === 'en'
                    ? 'This event is now in My events on Web and iOS.'
                    : '这场活动已经出现在你的 Web 与 iOS「我的活动」中。'}
            </p>
            <div className="registration-summary">
              <div>
                <strong>{event.title}</strong>
                <p>
                  {eventDate(event.startsAt, locale)} ·{' '}
                  {eventTime(event.startsAt, event.endsAt, locale)}
                </p>
                <p>{event.publicArea}</p>
              </div>
              <span>
                {waiting
                  ? `${t('event.waitlist')} ${result.waitlistPosition ?? ''}`
                  : locale === 'ja'
                    ? '確定'
                    : locale === 'en'
                      ? 'Confirmed'
                      : '已确认'}
              </span>
            </div>
            <Link className="primary-action" href="/me/events">
              {t('event.viewRegistration')}
            </Link>
            <Link className="secondary-action" href={`/e/${event.publicSlug}`}>
              {locale === 'ja'
                ? 'イベントに戻る'
                : locale === 'en'
                  ? 'Back to event'
                  : '返回活动页'}
            </Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="flow-shell">
        <div className="flow-progress">
          <span className="active" />
          <span className="active" />
          <span />
        </div>
        <Link className="back-link" href={`/e/${event.publicSlug}`}>
          ← {locale === 'ja' ? 'イベントに戻る' : locale === 'en' ? 'Back to event' : '返回活动'}
        </Link>
        <form className="flow-card" onSubmit={submit}>
          <span className="section-number">REGISTRATION / CONFIRM</span>
          <h1>{full ? t('registration.waitlistTitle') : t('registration.title')}</h1>
          <div className="registration-summary">
            <div>
              <strong>{event.title}</strong>
              <p>
                {eventDate(event.startsAt, locale)} ·{' '}
                {eventTime(event.startsAt, event.endsAt, locale)}
              </p>
              <p>{event.publicArea}</p>
            </div>
            <span>{event.priceLabel}</span>
          </div>
          <label className="form-field">
            {locale === 'ja' ? '参加人数' : locale === 'en' ? 'Party size' : '参加人数'}
            <select
              value={partySize}
              onChange={(input) => setPartySize(Number(input.target.value))}
            >
              {Array.from({ length: Math.min(10, Math.max(1, full ? event.capacity : event.capacity - event.confirmedCount)) }, (_, index) => (
                <option value={index + 1} key={index + 1}>
                  {index + 1} {t('common.people')}
                </option>
              ))}
            </select>
          </label>
          {Boolean(event.attendeeRequirements) && (
            <aside className="registration-requirements">
              <strong>
                {locale === 'ja'
                  ? '参加条件'
                  : locale === 'en'
                    ? 'Participation requirements'
                    : '参与条件'}
              </strong>
              <p>{event.attendeeRequirements}</p>
            </aside>
          )}
          {(event.registrationQuestions ?? []).some((question) => question.id) && (
            <fieldset className="registration-questions">
              <legend>{t('registration.questions')}</legend>
              {event.registrationQuestions
                ?.filter((question) => question.id)
                .map((question) => (
                  <label className="form-field" key={question.id}>
                    {question.prompt}{' '}
                    {question.required && <small>{t('registration.required')}</small>}
                    {question.kind === 'single_choice' ? (
                      <select
                        required={question.required}
                        value={String(answers[question.id!] ?? '')}
                        onChange={(input) =>
                          setAnswers((current) => ({
                            ...current,
                            [question.id!]: input.target.value,
                          }))
                        }
                      >
                        <option value="">—</option>
                        {question.options.map((option) => (
                          <option key={option}>{option}</option>
                        ))}
                      </select>
                    ) : question.kind === 'boolean' ? (
                      <select
                        required={question.required}
                        value={
                          answers[question.id!] === undefined ? '' : String(answers[question.id!])
                        }
                        onChange={(input) =>
                          setAnswers((current) => ({
                            ...current,
                            [question.id!]: input.target.value === 'true',
                          }))
                        }
                      >
                        <option value="">—</option>
                        <option value="true">
                          {locale === 'ja' ? 'はい' : locale === 'en' ? 'Yes' : '是'}
                        </option>
                        <option value="false">
                          {locale === 'ja' ? 'いいえ' : locale === 'en' ? 'No' : '否'}
                        </option>
                      </select>
                    ) : (
                      <textarea
                        required={question.required}
                        maxLength={1000}
                        value={String(answers[question.id!] ?? '')}
                        onChange={(input) =>
                          setAnswers((current) => ({
                            ...current,
                            [question.id!]: input.target.value,
                          }))
                        }
                      />
                    )}
                  </label>
                ))}
            </fieldset>
          )}
          <label className="form-field">
            {t('registration.note')}
            <textarea
              value={attendeeNote}
              onChange={(input) => setAttendeeNote(input.target.value)}
              maxLength={1000}
              placeholder={t('registration.notePlaceholder')}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(input) => setAccepted(input.target.checked)}
            />
            <span>
              <strong>{t('registration.acceptFee')}</strong>
              <small>{event.fee?.boundaryStatement ?? ''}</small>
            </span>
          </label>
          <div className="points-confirm">
            <div>
              <span>
                {locale === 'ja' ? '使用ポイント' : locale === 'en' ? 'Points used' : '本次消耗'}
              </span>
              <strong>
                {quote
                  ? `${quote.amount} ${locale === 'en' ? 'points' : '积分'}`
                  : locale === 'ja'
                    ? '送信時に最新価格を取得'
                    : locale === 'en'
                      ? 'Live price at confirmation'
                      : '提交时获取实时积分价格'}
              </strong>
            </div>
            <p>
              {locale === 'ja'
                ? 'キャンセルや重要変更時は規定に従って返還されます。参加費とは別です。'
                : locale === 'en'
                  ? 'Points are returned according to the cancellation rules. Offline event fees are separate.'
                  : '活动取消或关键变化后按规则退回。线下活动费不从积分扣除。'}
            </p>
          </div>
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          <button className="primary-action" disabled={busy}>
            {busy
              ? t('registration.submitting')
              : full
                ? t('registration.submitWaitlist')
                : t('registration.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}
