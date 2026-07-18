'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Footer } from '../../components/Footer';
import { EventCard } from '../../components/EventCard';
import { useI18n } from '../../components/I18nProvider';
import { usePreviewMode } from '../../components/PreviewModeProvider';
import { ReadOnlyCommunityNotice } from '../../components/ReadOnlyCommunityNotice';
import { normalizeEvent } from '../../lib/api';
import type { EventView } from '../../lib/demo-data';
import {
  APIError,
  apiRequest,
  errorMessage,
  readSession,
  type GroupAnnouncement,
  type GroupView,
} from '../../lib/client-api';
import { GroupDiscussion } from './GroupDiscussion';

export function GroupExperience({ slug }: { slug: string }) {
  const { locale, t } = useI18n();
  const isReadOnly = usePreviewMode() === 'read-only';
  const [group, setGroup] = useState<GroupView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [announcements, setAnnouncements] = useState<GroupAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const value = await apiRequest<GroupView>(`/groups/${encodeURIComponent(slug)}`);
      setGroup(value);
      const [eventResult, announcementResult] = await Promise.allSettled([
        apiRequest<{
          items: Array<Partial<EventView> & Pick<EventView, 'id' | 'publicSlug' | 'title'>>;
        }>('/events/search?limit=100'),
        apiRequest<{ items: GroupAnnouncement[] }>(`/groups/${value.id}/announcements?limit=30`),
      ]);
      if (eventResult.status === 'fulfilled')
        setEvents(
          eventResult.value.items.map(normalizeEvent).filter((event) => event.groupId === value.id),
        );
      if (announcementResult.status === 'fulfilled')
        setAnnouncements(announcementResult.value.items);
      else if (!(
        announcementResult.reason instanceof APIError && announcementResult.reason.status === 404
      ))
        setMessage(errorMessage(announcementResult.reason));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function join() {
    if (isReadOnly || !group) return;
    const session = readSession();
    if (!session) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/g/${slug}`)}`);
      return;
    }
    if (!session.user.phoneVerified) {
      window.location.assign(`/phone-verification?returnTo=${encodeURIComponent(`/g/${slug}`)}`);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const inviteCode = new URLSearchParams(window.location.search).get('invite');
      const result = await apiRequest<{ status: string }>(`/groups/${group.id}/join`, {
        method: 'POST',
        authenticated: true,
        idempotent: true,
        body: JSON.stringify(inviteCode ? { inviteCode } : {}),
      });
      setGroup({
        ...group,
        membershipStatus: result.status as GroupView['membershipStatus'],
        memberCount: result.status === 'active' ? group.memberCount + 1 : group.memberCount,
        availableActions: group.availableActions.filter((action) => action !== 'joinGroup'),
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    if (isReadOnly || !group) return;
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/g/${slug}`)}`);
      return;
    }
    const next = !group.viewerFollowing;
    setGroup({ ...group, viewerFollowing: next });
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/groups/${group.id}/follow`, {
        method: next ? 'PUT' : 'DELETE',
        authenticated: true,
      });
    } catch (error) {
      setGroup(group);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="standard-shell">
        <div className="loading-state">
          <span />
          <p>{t('common.loading')}</p>
        </div>
      </main>
    );
  if (!group)
    return (
      <main className="standard-shell">
        <div className="empty-state">
          <h1>
            {locale === 'ja'
              ? 'グループが見つかりません'
              : locale === 'en'
                ? 'Group not found'
                : '群组不存在'}
          </h1>
          <p>{message}</p>
          <Link className="primary-action compact" href="/groups" prefetch={isReadOnly ? false : undefined}>
            {t('group.directory')}
          </Link>
        </div>
      </main>
    );

  const joined =
    group.membershipStatus === 'active' || !group.availableActions.includes('joinGroup');
  return (
    <main>
      <div className="standard-shell">
        <section className="group-hero">
          {group.coverURL ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="group-cover-image" src={group.coverURL} alt="" />
          ) : (
            <div className="group-mark">{Array.from(group.name).slice(0, 2).join('')}</div>
          )}
          <div>
            <span className="eyebrow-text">
              {t('group.detailEyebrow', { region: t(regionMessageKey(group.regionId)) })}
            </span>
            <h1>{group.name}</h1>
            <p>
              {group.description ||
                (locale === 'ja'
                  ? '紹介はまだありません。'
                  : locale === 'en'
                    ? 'No description yet.'
                    : '群组还没有填写介绍。')}
            </p>
            <div className="tag-row">
              <span>{t('group.members', { count: group.memberCount })}</span>
              <span>{t('group.capacity', { count: group.capacity })}</span>
              <span>{joinModeLabel(group.joinMode, locale)}</span>
              {group.tags?.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </div>
          {!isReadOnly ? (
            <div className="group-hero-actions">
              {joined ? (
                <span className="joined-badge">
                  ✓ {group.membershipStatus === 'pending' ? t('group.pending') : t('group.joined')}
                </span>
              ) : (
                <button
                  className="primary-action compact"
                  type="button"
                  onClick={() => void join()}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {busy ? t('common.loading') : t('group.join')}
                </button>
              )}
              <button
                className={`secondary-action compact${group.viewerFollowing ? ' active' : ''}`}
                type="button"
                onClick={() => void follow()}
                disabled={busy}
                aria-busy={busy}
              >
                {group.viewerFollowing
                  ? locale === 'ja'
                    ? 'フォロー中'
                    : locale === 'en'
                      ? 'Following'
                      : '已关注'
                  : locale === 'ja'
                    ? 'グループをフォロー'
                    : locale === 'en'
                      ? 'Follow group'
                      : '关注群组'}
              </button>
            </div>
          ) : null}
        </section>
        {isReadOnly ? <ReadOnlyCommunityNotice /> : null}
        {message && (
          <p className="form-message group-message" role="alert">
            {message}
          </p>
        )}
        <section className="event-section group-events">
          <div className="section-heading">
            <div>
              <span className="section-number">{t('group.upNext')}</span>
              <h2>{t('group.events')}</h2>
            </div>
          </div>
          {events.length ? (
            <div className="event-grid wide">
              {events.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <h2>
                {locale === 'ja'
                  ? '予定されているイベントはありません'
                  : locale === 'en'
                    ? 'No upcoming events'
                    : '暂时没有即将开始的群组活动'}
              </h2>
              <p>
                {locale === 'ja'
                  ? '新しいイベントは Web と iOS に同時に表示されます。'
                  : locale === 'en'
                    ? 'New events will appear on Web and iOS at the same time.'
                    : '新活动发布后会同时出现在 Web 与 iOS。'}
              </p>
            </div>
          )}
        </section>
        <GroupDiscussion group={group} initialItems={announcements} />
      </div>
      <Footer />
    </main>
  );
}

function joinModeLabel(mode: GroupView['joinMode'], locale: 'zh-Hans' | 'ja' | 'en') {
  if (mode === 'approval')
    return locale === 'ja' ? '承認制' : locale === 'en' ? 'Approval required' : '审核加入';
  if (mode === 'invite_only')
    return locale === 'ja' ? '招待のみ' : locale === 'en' ? 'Invite only' : '仅限邀请';
  return locale === 'ja' ? '誰でも参加' : locale === 'en' ? 'Open to join' : '公开加入';
}

function regionMessageKey(regionId: string | null | undefined) {
  switch (regionId) {
    case 'tokyo': return 'region.tokyo' as const;
    case 'kanagawa': return 'region.kanagawa' as const;
    case 'saitama': return 'region.saitama' as const;
    case 'chiba': return 'region.chiba' as const;
    case 'osaka': return 'region.osaka' as const;
    case 'kyoto': return 'region.kyoto' as const;
    default: return 'region.all' as const;
  }
}
