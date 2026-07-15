'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EventView } from '../lib/demo-data';
import { normalizeEvent } from '../lib/api';
import { trackProductEvent } from '../lib/analytics';
import { apiRequest, errorMessage } from '../lib/client-api';
import { EventCard } from './EventCard';
import { SearchIcon } from './icons';
import { useI18n } from './I18nProvider';

interface SearchPayload {
  items: Array<Partial<EventView> & Pick<EventView, 'id' | 'publicSlug' | 'title'>>;
  nextCursor: string | null;
  hasMore: boolean;
}

type DateFilter = 'any' | 'today' | 'weekend' | 'week';

const categories = [
  ['all', { 'zh-Hans': '全部', ja: 'すべて', en: 'All' }],
  ['city-walk', { 'zh-Hans': '城市探索', ja: 'まち歩き', en: 'City walks' }],
  ['music', { 'zh-Hans': '音乐', ja: '音楽', en: 'Music' }],
  ['food', { 'zh-Hans': '美食与咖啡', ja: 'フード', en: 'Food' }],
  ['outdoor', { 'zh-Hans': '户外', ja: 'アウトドア', en: 'Outdoors' }],
  ['art', { 'zh-Hans': '艺术与创作', ja: 'アート', en: 'Arts' }],
  ['language', { 'zh-Hans': '语言交换', ja: '言語交換', en: 'Language' }],
  ['sports', { 'zh-Hans': '运动', ja: 'スポーツ', en: 'Sports' }],
  ['games', { 'zh-Hans': '桌游', ja: 'ゲーム', en: 'Games' }],
  ['learning', { 'zh-Hans': '学习', ja: '学び', en: 'Learning' }],
  ['wellness', { 'zh-Hans': '身心健康', ja: 'ウェルネス', en: 'Wellness' }],
  ['networking', { 'zh-Hans': '职业交流', ja: '交流会', en: 'Networking' }],
] as const;

const regions = [
  ['', { 'zh-Hans': '日本全部', ja: '日本全国', en: 'All Japan' }],
  ['tokyo', { 'zh-Hans': '东京', ja: '東京', en: 'Tokyo' }],
  ['kanagawa', { 'zh-Hans': '神奈川', ja: '神奈川', en: 'Kanagawa' }],
  ['saitama', { 'zh-Hans': '埼玉', ja: '埼玉', en: 'Saitama' }],
  ['chiba', { 'zh-Hans': '千叶', ja: '千葉', en: 'Chiba' }],
  ['osaka', { 'zh-Hans': '大阪', ja: '大阪', en: 'Osaka' }],
  ['kyoto', { 'zh-Hans': '京都', ja: '京都', en: 'Kyoto' }],
] as const;

export function DiscoverExperience({
  initialEvents,
  initialCategory = 'all',
}: {
  initialEvents: EventView[];
  initialCategory?: string;
}) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState(initialEvents);
  const [category, setCategory] = useState(initialCategory);
  const [region, setRegion] = useState('');
  const [date, setDate] = useState<DateFilter>('any');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void trackProductEvent('discovery_viewed', {
      category: initialCategory,
      initialResultCount: initialEvents.length,
    });
  }, [initialCategory, initialEvents.length]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const initialQuery = params.get('q') ?? '';
      const categoryFromURL = params.get('category') ?? initialCategory;
      const initialRegion = params.get('region') ?? '';
      const initialDate = params.get('when') as DateFilter | null;
      setQuery(initialQuery);
      setDebouncedQuery(initialQuery);
      if (categories.some(([value]) => value === categoryFromURL)) setCategory(categoryFromURL);
      if (regions.some(([value]) => value === initialRegion)) setRegion(initialRegion);
      if (initialDate && ['any', 'today', 'weekend', 'week'].includes(initialDate))
        setDate(initialDate);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialCategory]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 320);
    return () => window.clearTimeout(timer);
  }, [query]);

  const search = useCallback(
    async (append = false, cursor?: string | null) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setMessage('');
      try {
        const params = new URLSearchParams({ limit: '24' });
        if (debouncedQuery) params.set('q', debouncedQuery);
        if (region) params.set('region', region);
        if (category !== 'all') params.set('category', category);
        if (append && cursor) params.set('cursor', cursor);
        const payload = await apiRequest<SearchPayload>(`/events/search?${params}`);
        const normalized = payload.items.map(normalizeEvent);
        setItems((current) =>
          append
            ? [
                ...current,
                ...normalized.filter((event) => !current.some((item) => item.id === event.id)),
              ]
            : normalized,
        );
        setNextCursor(payload.nextCursor);
        setHasMore(payload.hasMore);
        void trackProductEvent('event_search_completed', {
          category,
          region: region || 'all',
          queryPresent: Boolean(debouncedQuery),
          resultCount: normalized.length,
          page: append ? 'next' : 'first',
        });
      } catch (error) {
        setMessage(errorMessage(error));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [category, debouncedQuery, region],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void search(false), 0);
    const params = new URLSearchParams();
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (category !== 'all') params.set('category', category);
    if (region) params.set('region', region);
    if (date !== 'any') params.set('when', date);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    );
    return () => window.clearTimeout(timer);
  }, [category, date, debouncedQuery, region, search]);

  const filtered = useMemo(
    () =>
      items.filter((event) => {
        if (availableOnly && event.capacity > 0 && event.confirmedCount >= event.capacity)
          return false;
        if (date === 'any') return true;
        const start = tokyoParts(event.startsAt);
        const now = tokyoParts(new Date().toISOString());
        if (date === 'today') return start.key === now.key;
        const difference = Math.floor((start.midnight - now.midnight) / 86_400_000);
        if (date === 'week') return difference >= 0 && difference <= 7;
        return difference >= 0 && difference <= 7 && [0, 6].includes(start.weekday);
      }),
    [availableOnly, date, items],
  );

  function reset() {
    setQuery('');
    setDebouncedQuery('');
    setCategory('all');
    setRegion('');
    setDate('any');
    setAvailableOnly(false);
  }

  return (
    <>
      <section className="discover-hero">
        <div className="eyebrow">
          <span /> {t('discover.eyebrow')}
        </div>
        <div className="hero-heading-row">
          <div>
            <p className="kicker">{t('discover.kicker')}</p>
            <h1>
              {t('discover.title')
                .split('\n')
                .map((line) => (
                  <span key={line}>
                    {line}
                    <br />
                  </span>
                ))}
            </h1>
          </div>
          <p className="hero-note">
            {t('discover.note')
              .split('\n')
              .map((line) => (
                <span key={line}>
                  {line}
                  <br />
                </span>
              ))}
          </p>
        </div>
        <div className="search-panel discover-search-panel" id="search">
          <label className="search-box">
            <SearchIcon size={22} />
            <span className="sr-only">{t('nav.search')}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('discover.searchPlaceholder')}
              autoComplete="off"
            />
          </label>
          <label className="region-chip">
            <span className="pulse-dot" />
            <span className="sr-only">{t('discover.region')}</span>
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              {regions.map(([value, labels]) => (
                <option key={value} value={value}>
                  {labels[locale]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="category-strip" role="group" aria-label={t('discover.category')}>
          {categories.map(([value, labels]) => (
            <button
              type="button"
              key={value}
              className={category === value ? 'active' : ''}
              onClick={() => setCategory(value)}
              aria-pressed={category === value}
            >
              {labels[locale]}
            </button>
          ))}
        </div>
        <div className="filter-bar">
          <div className="segmented-filter" aria-label={t('discover.when')}>
            <button className={date === 'any' ? 'active' : ''} onClick={() => setDate('any')}>
              {t('discover.anytime')}
            </button>
            <button className={date === 'today' ? 'active' : ''} onClick={() => setDate('today')}>
              {t('discover.today')}
            </button>
            <button
              className={date === 'weekend' ? 'active' : ''}
              onClick={() => setDate('weekend')}
            >
              {t('discover.weekend')}
            </button>
            <button className={date === 'week' ? 'active' : ''} onClick={() => setDate('week')}>
              {t('discover.nextWeek')}
            </button>
          </div>
          <label className="availability-toggle">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={(event) => setAvailableOnly(event.target.checked)}
            />
            <span />
            {t('discover.availability')}
          </label>
        </div>
      </section>

      <section className="event-section" aria-busy={loading} aria-live="polite">
        <div className="section-heading">
          <div>
            <span className="section-number">EXPLORE</span>
            <h2>{t('discover.results')}</h2>
          </div>
          <p>{t('discover.resultCount', { count: filtered.length })}</p>
        </div>
        {message && (
          <div className="inline-error" role="alert">
            <p>{t('discover.error')}</p>
            <button onClick={() => void search(false)}>{t('common.retry')}</button>
          </div>
        )}
        {loading ? (
          <div className="event-skeleton-grid" aria-label={t('common.loading')}>
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
        ) : filtered.length ? (
          <div className="event-grid discovery-grid">
            {filtered.map((event) => (
              <EventCard event={event} key={event.id} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span className="spotlight-empty" />
            <h2>{t('discover.emptyTitle')}</h2>
            <p>{t('discover.emptyBody')}</p>
            <button onClick={reset}>{t('common.clear')}</button>
          </div>
        )}
        {hasMore && !loading && (
          <button
            className="load-more"
            type="button"
            onClick={() => void search(true, nextCursor)}
            disabled={loadingMore}
          >
            {loadingMore ? t('common.loading') : t('common.more')} <span aria-hidden="true">↓</span>
          </button>
        )}
      </section>

      <section className="host-invitation">
        <div className="invitation-mark">
          <span>SPOTT</span>
          <strong>＋</strong>
        </div>
        <div>
          <span className="section-number">HOST</span>
          <h2>{t('discover.hostTitle')}</h2>
          <p>{t('discover.hostBody')}</p>
        </div>
        <Link className="text-link" href="/create">
          {t('discover.hostCta')} <span aria-hidden="true">↗</span>
        </Link>
      </section>
    </>
  );
}

function tokyoParts(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const key = `${get('year')}-${get('month')}-${get('day')}`;
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    key,
    midnight: new Date(`${key}T00:00:00+09:00`).getTime(),
    weekday: weekdays[get('weekday')] ?? 0,
  };
}
