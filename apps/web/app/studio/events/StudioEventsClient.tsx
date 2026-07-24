'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppDialog } from '../../components/AppDialog';
import { useI18n } from '../../components/I18nProvider';
import { normalizeEvent } from '../../lib/api';
import type { EventView } from '../../lib/demo-data';
import { APIError, apiRequest, errorMessage } from '../../lib/client-api';
import { eventDate, eventTime } from '../../lib/format';
import { StudioNav } from '../StudioNav';

type Filter = 'all' | 'live' | 'review' | 'draft' | 'past';

interface PosterJob {
  id: string;
  state: 'queued' | 'processing' | 'ready' | 'failed';
  url: string | null;
  failureCode: string | null;
  template: string;
  locale: string;
}

export function StudioEventsClient() {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const [items, setItems] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [code, setCode] = useState<{
    eventId: string;
    mode: 'dynamic_qr' | 'six_digit';
    value: string;
    validFrom: string;
    validUntil: string;
  } | null>(null);
  const [posterEventId, setPosterEventId] = useState('');
  const [posterJob, setPosterJob] = useState<PosterJob | null>(null);
  const [posterTemplate, setPosterTemplate] = useState('tokyo_afterglow');
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterMessage, setPosterMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiRequest<{
        items: Array<Partial<EventView> & Pick<EventView, 'id' | 'publicSlug' | 'title'>>;
      }>('/me/hosted-events', { authenticated: true });
      setItems(payload.items.map(normalizeEvent));
      setMessage('');
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
      all: items.length,
      live: items.filter((item) =>
        ['published', 'registration_closed', 'in_progress'].includes(item.status),
      ).length,
      review: items.filter((item) => ['submitted', 'under_review'].includes(item.status)).length,
      draft: items.filter((item) => item.status === 'draft').length,
      past: items.filter(
        (item) =>
          ['ended', 'cancelled'].includes(item.status) || new Date(item.endsAt) < new Date(),
      ).length,
    }),
    [items],
  );
  const visible = items.filter((item) => {
    const matchQuery = `${item.title} ${item.publicArea}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    if (!matchQuery) return false;
    if (filter === 'all') return true;
    if (filter === 'live')
      return ['published', 'registration_closed', 'in_progress'].includes(item.status);
    if (filter === 'review') return ['submitted', 'under_review'].includes(item.status);
    if (filter === 'draft') return item.status === 'draft';
    return ['ended', 'cancelled'].includes(item.status) || new Date(item.endsAt) < new Date();
  });
  async function cancel(event: EventView) {
    const reasonLabel = locale === 'ja'
      ? 'キャンセル理由を入力してください（参加者に通知されます）'
      : locale === 'en'
        ? 'Why are you cancelling? Attendees will be notified.'
        : '请输入取消原因（将通知参加者）';
    await appDialog.run({
      title: locale === 'ja' ? 'イベントをキャンセル' : locale === 'en' ? 'Cancel event' : '取消活动',
      confirmLabel: locale === 'ja' ? 'キャンセルする' : locale === 'en' ? 'Cancel event' : '确认取消',
      destructive: true,
      input: { label: reasonLabel, required: true, minLength: 3, multiline: true },
      onConfirm: async (reason) => {
        try {
          await apiRequest(`/events/${event.id}/cancel`, {
            method: 'POST',
            authenticated: true,
            idempotent: true,
            body: JSON.stringify({ reason }),
          });
          await load();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }
  async function checkin(event: EventView) {
    try {
      const value = await apiRequest<{
        mode: 'dynamic_qr' | 'six_digit';
        token: string | null;
        code: string | null;
        validFrom: string;
        validUntil: string;
      }>(
        `/events/${event.id}/checkin-codes`,
        {
          method: 'POST',
          authenticated: true,
          body: JSON.stringify({
            mode: event.checkinMode === 'six_digit' ? 'six_digit' : 'dynamic_qr',
          }),
        },
      );
      const credential = value.code ?? value.token;
      if (!credential) throw new Error('Check-in credential unavailable.');
      setCode({
        eventId: event.id,
        mode: value.mode,
        value: credential,
        validFrom: value.validFrom,
        validUntil: value.validUntil,
      });
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function openPoster(event: EventView) {
    if (posterEventId === event.id) {
      setPosterEventId('');
      setPosterJob(null);
      return;
    }
    setPosterEventId(event.id);
    setPosterJob(null);
    setPosterMessage('');
    setPosterBusy(true);
    try {
      const current = await apiRequest<PosterJob>(`/events/${event.id}/poster`, {
        authenticated: true,
      });
      setPosterJob(current);
      if (current.state === 'queued' || current.state === 'processing') {
        await pollPoster(current.id);
      }
    } catch (error) {
      if (!(error instanceof APIError && error.status === 404)) setPosterMessage(errorMessage(error));
    } finally {
      setPosterBusy(false);
    }
  }

  async function createPoster(event: EventView) {
    setPosterBusy(true);
    setPosterMessage('');
    try {
      const receipt = await apiRequest<{ id: string }>('/posters', {
        method: 'POST',
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({
          resourceType: 'event',
          resourceId: event.id,
          template: posterTemplate,
          locale,
          mode: 'template',
        }),
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await apiRequest<PosterJob>(`/posters/${receipt.id}`, {
          authenticated: true,
        });
        setPosterJob(current);
        if (current.state === 'ready' || current.state === 'failed') break;
        if (attempt < 19) await delay(1000);
      }
    } catch (error) {
      setPosterMessage(errorMessage(error));
    } finally {
      setPosterBusy(false);
    }
  }

  async function pollPoster(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await apiRequest<PosterJob>(`/posters/${jobId}`, {
        authenticated: true,
      });
      setPosterJob(current);
      if (current.state === 'ready' || current.state === 'failed') return;
      if (attempt < 19) await delay(1000);
    }
  }

  async function sharePoster(url: string) {
    if (navigator.share) {
      await navigator.share({ url });
      return;
    }
    await navigator.clipboard.writeText(url);
    setPosterMessage(locale === 'ja' ? 'リンクをコピーしました。' : locale === 'en' ? 'Link copied.' : '海报链接已复制。');
  }
  const copy =
    locale === 'ja'
      ? {
          title: 'イベント管理',
          body: '公開、申込、当日のチェックインを Web と iOS で同じ状態に保ちます。',
          upcoming: '公開中',
          attendees: '申込者',
          drafts: '下書き・審査',
          search: 'イベントを検索',
          empty: '該当するイベントはありません',
        }
      : locale === 'en'
        ? {
            title: 'Event management',
            body: 'Keep publishing, registration, and check-in in sync across Web and iOS.',
            upcoming: 'Live events',
            attendees: 'Registrations',
            drafts: 'Drafts & review',
            search: 'Search events',
            empty: 'No events match this view',
          }
        : {
            title: '活动管理',
            body: '发布、报名和现场签到在 Web 与 iOS 保持同一状态。',
            upcoming: '进行中的活动',
            attendees: '累计报名',
            drafts: '草稿与审核',
            search: '搜索活动',
            empty: '当前筛选没有活动',
          };
  return (
    <main className="studio-shell">
      <StudioNav current="events" />
      <section className="studio-content">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">HOST STUDIO / LIVE DATA</span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <Link className="create-button" href="/create">
            ＋ {t('nav.create')}
          </Link>
        </div>
        <div className="metric-grid studio-metrics">
          <div>
            <span>{copy.upcoming}</span>
            <strong>{counts.live}</strong>
            <small>
              {locale === 'ja'
                ? `公開中 ${items.filter((item) => item.status === 'published').length}`
                : locale === 'en'
                  ? `${items.filter((item) => item.status === 'published').length} published`
                  : `已发布 ${items.filter((item) => item.status === 'published').length}`}
            </small>
          </div>
          <div>
            <span>{copy.attendees}</span>
            <strong>{items.reduce((sum, item) => sum + item.confirmedCount, 0)}</strong>
            <small>{locale === 'ja' ? '確定済み' : locale === 'en' ? 'confirmed' : '已确认'}</small>
          </div>
          <div>
            <span>{copy.drafts}</span>
            <strong>{counts.draft + counts.review}</strong>
            <small>
              {locale === 'ja'
                ? `審査中 ${counts.review}`
                : locale === 'en'
                  ? `${counts.review} in review`
                  : `审核中 ${counts.review}`}
            </small>
          </div>
        </div>
        <div className="studio-toolbar">
          <div className="dashboard-tabs">
            {(['all', 'live', 'review', 'draft', 'past'] as Filter[]).map((value) => (
              <button
                key={value}
                className={filter === value ? 'active' : ''}
                onClick={() => setFilter(value)}
              >
                {filterLabel(value, locale)} <span>{counts[value]}</span>
              </button>
            ))}
          </div>
          <label className="table-search">
            <span className="sr-only">{copy.search}</span>
            <input
              type="search"
              placeholder={copy.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{t('common.loading')}</p>
          </div>
        ) : visible.length ? (
          <div className="host-event-list">
            {visible.map((event) => (
              <article key={event.id}>
                <div>
                  <span className={`event-status status-${event.status}`}>
                    {statusLabel(event.status, locale)}
                  </span>
                  <h2>
                    {event.title ||
                      (locale === 'ja'
                        ? '無題の下書き'
                        : locale === 'en'
                          ? 'Untitled draft'
                          : '未命名草稿')}
                  </h2>
                  <p>
                    {eventDate(event.startsAt, locale)} ·{' '}
                    {eventTime(event.startsAt, event.endsAt, locale)} · {event.publicArea}
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>{locale === 'ja' ? '申込' : locale === 'en' ? 'Registered' : '报名'}</dt>
                    <dd>
                      {event.confirmedCount} / {event.capacity}
                    </dd>
                  </div>
                  <div>
                    <dt>{locale === 'ja' ? '版' : locale === 'en' ? 'Version' : '版本'}</dt>
                    <dd>v{event.version ?? 1}</dd>
                  </div>
                </dl>
                <div className="row-actions">
                  <Link href={`/e/${event.publicSlug}`}>{t('common.open')}</Link>
                  {['draft', 'needs_changes', 'published'].includes(event.status) && (
                    <Link href={`/studio/events/${event.id}/edit`}>
                      {t('studio.events.actionEdit')}
                    </Link>
                  )}
                  {['published', 'registration_closed', 'in_progress'].includes(event.status) && (
                    <Link href={`/studio/events/${event.id}/attendees`}>
                      {locale === 'ja'
                        ? '申込者を管理'
                        : locale === 'en'
                          ? 'Manage attendees'
                          : '管理报名与签到'}
                    </Link>
                  )}
                  {['draft', 'needs_changes', 'published', 'registration_closed', 'in_progress'].includes(
                    event.status,
                  ) && (
                    <Link href={`/studio/events/${event.id}/tickets`}>
                      {t('studio.events.actionTickets')}
                    </Link>
                  )}
                  {['published', 'registration_closed', 'in_progress'].includes(event.status) && (
                    <Link href={`/studio/events/${event.id}/announcements`}>
                      {t('studio.events.actionAnnouncements')}
                    </Link>
                  )}
                  {event.status === 'published' && (
                    <Link href={`/studio/events/${event.id}/promotion`}>
                      {t('studio.events.actionPromotion')}
                    </Link>
                  )}
                  {(event.status === 'ended' || new Date(event.endsAt) < new Date()) && (
                    <Link href={`/studio/events/${event.id}/feedback`}>
                      {locale === 'ja'
                        ? '参加後のフィードバック'
                        : locale === 'en'
                          ? 'Post-event feedback'
                          : '活动后反馈'}
                    </Link>
                  )}
                  {['published', 'registration_closed', 'in_progress'].includes(event.status) &&
                    event.checkinMode !== 'manual' && (
                    <button onClick={() => void checkin(event)}>
                      {locale === 'ja'
                        ? 'チェックインコード'
                        : locale === 'en'
                          ? 'Check-in code'
                          : '签到码'}
                    </button>
                  )}
                  {['published', 'registration_closed', 'in_progress', 'ended'].includes(event.status) && (
                    <button onClick={() => void openPoster(event)}>
                      {locale === 'ja' ? '共有ポスター' : locale === 'en' ? 'Share poster' : '分享海报'}
                    </button>
                  )}
                  {['published', 'registration_closed'].includes(event.status) && (
                    <button className="danger-text" onClick={() => void cancel(event)}>
                      {locale === 'ja' ? '中止' : locale === 'en' ? 'Cancel' : '取消'}
                    </button>
                  )}
                </div>
                {code?.eventId === event.id && (
                  <div className="checkin-code-panel">
                    <span>
                      {code.mode === 'six_digit'
                        ? locale === 'ja'
                          ? '6桁コード · 30秒有効'
                          : locale === 'en'
                            ? '6-digit code · valid for 30 seconds'
                            : '6 位签到码 · 30 秒有效'
                        : locale === 'ja'
                          ? 'QRトークン · 30秒有効'
                          : locale === 'en'
                            ? 'QR token · valid for 30 seconds'
                            : '二维码令牌 · 30 秒有效'}
                    </span>
                    <strong>{code.value}</strong>
                    <button onClick={() => navigator.clipboard.writeText(code.value)}>
                      {locale === 'ja' ? 'コピー' : locale === 'en' ? 'Copy' : '复制'}
                    </button>
                  </div>
                )}
                {posterEventId === event.id && (
                  <div className="poster-manager-panel">
                    <div>
                      <span className="section-number">APPROVED PUBLIC CONTENT</span>
                      <strong>
                        {locale === 'ja'
                          ? 'ブランド共有ポスター'
                          : locale === 'en'
                            ? 'Branded share poster'
                            : '品牌分享海报'}
                      </strong>
                      <p>
                        {locale === 'ja'
                          ? '公開が許可された情報のみを使用し、正確な住所、電話番号、申込回答は含みません。'
                          : locale === 'en'
                            ? 'Uses only approved public content and never includes exact addresses, phone numbers, or registration answers.'
                            : '只使用已获准公开的内容，不包含精确地址、手机号或报名答案。'}
                      </p>
                    </div>
                    {posterJob?.state === 'ready' && posterJob.url ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={posterJob.url} alt="" />
                        <button className="primary-action compact" onClick={() => void sharePoster(posterJob.url!)}>
                          {locale === 'ja' ? 'ポスターを共有' : locale === 'en' ? 'Share poster' : '分享海报'}
                        </button>
                      </>
                    ) : posterBusy || posterJob?.state === 'queued' || posterJob?.state === 'processing' ? (
                      <div className="poster-processing"><span /><p>{locale === 'ja' ? '生成中…' : locale === 'en' ? 'Generating…' : '正在生成…'}</p></div>
                    ) : (
                      <div className="poster-create-row">
                        <label>
                          {locale === 'ja' ? 'スタイル' : locale === 'en' ? 'Style' : '风格'}
                          <select value={posterTemplate} onChange={(event) => setPosterTemplate(event.target.value)}>
                            <option value="tokyo_afterglow">{locale === 'ja' ? '東京の余光' : locale === 'en' ? 'Tokyo Afterglow' : '东京余光'}</option>
                            <option value="night_transit">{locale === 'ja' ? '夜の電車' : locale === 'en' ? 'Night Transit' : '夜间电车'}</option>
                            <option value="paper_lantern">{locale === 'ja' ? '紙灯籠' : locale === 'en' ? 'Paper Lantern' : '纸灯笼'}</option>
                          </select>
                        </label>
                        <button className="primary-action compact" onClick={() => void createPoster(event)}>
                          {posterJob?.state === 'failed'
                            ? locale === 'ja' ? '再生成' : locale === 'en' ? 'Try again' : '重新生成'
                            : locale === 'ja' ? 'ポスターを生成' : locale === 'en' ? 'Generate poster' : '生成海报'}
                        </button>
                      </div>
                    )}
                    {posterMessage && <p className="form-message" role="status">{posterMessage}</p>}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
            <Link className="primary-action compact" href="/create">
              {t('nav.create')}
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

function filterLabel(value: Filter, locale: 'zh-Hans' | 'ja' | 'en') {
  const labels = {
    all: ['全部', 'すべて', 'All'],
    live: ['进行中', '公開中', 'Live'],
    review: ['审核中', '審査中', 'Review'],
    draft: ['草稿', '下書き', 'Drafts'],
    past: ['已结束', '終了', 'Past'],
  } as const;
  const index = locale === 'ja' ? 1 : locale === 'en' ? 2 : 0;
  return labels[value][index];
}
function statusLabel(value: string, locale: 'zh-Hans' | 'ja' | 'en') {
  const labels: Record<string, [string, string, string]> = {
    draft: ['草稿', '下書き', 'Draft'],
    submitted: ['已提交', '提出済み', 'Submitted'],
    under_review: ['审核中', '審査中', 'In review'],
    published: ['已发布', '公開中', 'Published'],
    registration_closed: ['报名结束', '受付終了', 'Registration closed'],
    in_progress: ['进行中', '開催中', 'In progress'],
    ended: ['已结束', '終了', 'Ended'],
    cancelled: ['已取消', '中止', 'Cancelled'],
  };
  const index = locale === 'ja' ? 1 : locale === 'en' ? 2 : 0;
  return labels[value]?.[index] ?? value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
