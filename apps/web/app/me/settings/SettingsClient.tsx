"use client";

import { PreviewModeLink as Link } from "../../components/PreviewModeLink";
import { useCallback, useEffect, useState } from "react";
import { useAppDialog } from "../../components/AppDialog";
import { useI18n } from "../../components/I18nProvider";
import { localeNames, type Locale } from "../../i18n/messages";
import { analyticsConsent, setAnalyticsConsent, trackProductEvent } from "../../lib/analytics";
import { apiRequest, errorMessage, logoutCurrentSession, readSession } from "../../lib/client-api";
import { uploadProcessedImage } from "../../lib/media-upload";
import { DashboardNav } from "../DashboardNav";

interface Profile {
  userId: string;
  nickname: string;
  bio: string;
  regionId: string;
  preferredLocale: Locale;
  contentLanguages: Locale[];
  avatarURL?: string | null;
  version: number;
  updatedAt: string;
}

interface Preference {
  type: string;
  inApp: boolean;
  push: boolean;
  email: boolean;
  quietHours: string | null;
  locale: Locale;
}

interface Achievement {
  id: string;
  code: string;
  audience: string;
  visibility: string;
  awardedAt: string;
  revokedAt: string | null;
}

interface AchievementProgress {
  checked_in_count: number;
  hosted_ended_count: number;
  owned_group_members: number;
}

const notificationTypes = [
  "event.critical",
  "registration.status",
  "group.update",
  "recommendation",
] as const;

const regions = [
  ["tokyo", "东京", "東京", "Tokyo"],
  ["kanagawa", "神奈川", "神奈川", "Kanagawa"],
  ["saitama", "埼玉", "埼玉", "Saitama"],
  ["chiba", "千叶", "千葉", "Chiba"],
  ["osaka", "大阪", "大阪", "Osaka"],
  ["kyoto", "京都", "京都", "Kyoto"],
] as const;

const achievementDefinitions = [
  { code: "first_checkin", metric: "checked_in_count", threshold: 1 },
  { code: "city_explorer_5", metric: "checked_in_count", threshold: 5 },
  { code: "first_hosted_event", metric: "hosted_ended_count", threshold: 1 },
  { code: "community_builder", metric: "owned_group_members", threshold: 10 },
] as const;

export function SettingsClient() {
  const { locale, setLocale: applyInterfaceLocale } = useI18n();
  const appDialog = useAppDialog();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [preferredLocale, setPreferredLocale] = useState<Preference["locale"]>("zh-Hans");
  const [contentLanguages, setContentLanguages] = useState<Locale[]>(["zh-Hans"]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [achievementProgress, setAchievementProgress] = useState<AchievementProgress | null>(null);
  const [deletionPending, setDeletionPending] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const evaluated = await apiRequest<{ metrics: AchievementProgress }>(
        "/me/achievements/evaluate",
        { method: "POST", authenticated: true },
      ).catch(() => null);
      const [profileValue, preferences, achievementPage] = await Promise.all([
        apiRequest<Profile>("/me/profile", { authenticated: true }),
        apiRequest<{ items: Preference[] }>("/notifications/preferences", {
          authenticated: true,
        }),
        apiRequest<{ items: Achievement[] }>("/me/achievements", {
          authenticated: true,
        }).catch(() => ({ items: [] })),
      ]);
      setProfile(profileValue);
      setPreferredLocale(profileValue.preferredLocale ?? "zh-Hans");
      setContentLanguages(
        profileValue.contentLanguages?.length ? profileValue.contentLanguages : ["zh-Hans"],
      );
      setAchievements(achievementPage.items.filter((item) => !item.revokedAt));
      setAchievementProgress(evaluated?.metrics ?? null);
      const values: Record<string, boolean> = {};
      for (const item of preferences.items) values[item.type] = item.inApp;
      setPrefs(values);
      if (!profileValue.preferredLocale && preferences.items[0])
        setPreferredLocale(preferences.items[0].locale);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAnalyticsEnabled(analyticsConsent());
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const copy =
    locale === "ja"
      ? {
          title: "プロフィールと設定",
          syncing: "同期中",
          connected: "クラウド接続済み",
          public: "公開プロフィール",
          avatar: "プロフィール画像",
          avatarBody: "ウイルススキャンと安全審査の完了後、iOS と Web の画像を同時に更新します。",
          avatarChange: "画像を選択",
          avatarSaved: "プロフィール画像を更新しました。",
          nickname: "表示名",
          bio: "自己紹介",
          region: "よく使うエリア",
          interface: "表示言語",
          content: "表示したいイベントの言語",
          identity: "本人確認とセキュリティ",
          mergeAccount: "別のアカウントを統合",
          mergeBody: "別の既存アカウントを再認証し、影響と競合を確認してから統合します。",
          mergeAction: "安全に統合",
          phone: "日本の電話番号",
          phoneVerified: "認証済み · 番号は公開されません",
          phoneNeeded: "申込、公開、グループ操作の前に認証が必要です",
          verified: "認証済み",
          pending: "未認証",
          session: "現在の Web セッション",
          sessionBody: "更新トークンのローテーションで保護されています",
          safety: "安全センター",
          safetyBody: "案件の進捗、異議申立て、ブロック中のユーザーを非公開で確認",
          safetyOpen: "開く",
          achievements: "実績",
          achievementsBody: "参加、主催、コミュニティづくりの節目は iOS と Web に同期されます。",
          unlocked: "獲得済み",
          locked: "進行中",
          logout: "ログアウト",
          logoutFailed: "ログアウトを完了できませんでした。もう一度お試しください。",
          logoutAll: "すべての端末からログアウト",
          logoutAllBody: "iOS と Web のすべてのセッションを取り消します",
          logoutAllConfirm: "すべての端末からログアウトしますか？もう一度ログインが必要です。",
          notifications: "通知",
          analytics: "匿名プロダクト分析",
          analyticsBody: "検索語や連絡先などの内容は送信せず、主要な導線の改善に必要な最小限の利用状況だけを共有します。",
          saving: "保存中…",
          save: "変更を保存",
          delete: "アカウント削除",
          deleteBody: "申請前に主催イベント、グループ所有権、ウォレット責任を確認します。",
          requestDelete: "削除を申請",
          cancelDelete: "削除申請を取り消す",
          cancelDeleteConfirm: "アカウント削除申請を取り消しますか？",
          deleteCancelled: "アカウント削除申請を取り消しました。",
          loading: "プロフィールと通知設定を同期中…",
          confirmDelete:
            "アカウント削除を申請しますか？未完了イベントやグループ所有権を確認後、待機期間に入ります。",
          deleteRecorded: "削除申請を受け付けました。最短実行日時",
        }
      : locale === "en"
        ? {
            title: "Profile & settings",
            syncing: "Syncing",
            connected: "Connected to cloud",
            public: "Public profile",
            avatar: "Profile image",
            avatarBody: "After virus scanning and safety review, the image updates across iOS and Web together.",
            avatarChange: "Choose image",
            avatarSaved: "Profile image updated.",
            nickname: "Display name",
            bio: "Bio",
            region: "Home area",
            interface: "Interface language",
            content: "Event content languages",
            identity: "Identity & security",
            mergeAccount: "Merge another account",
            mergeBody: "Reverify another existing account, review impact and conflicts, then confirm the merge.",
            mergeAction: "Merge securely",
            phone: "Japanese phone number",
            phoneVerified: "Verified · your number is never public",
            phoneNeeded: "Required before registration, publishing, and group actions",
            verified: "Verified",
            pending: "Not verified",
            session: "Current Web session",
            sessionBody: "Protected by rotating refresh tokens",
            safety: "Safety center",
            safetyBody: "Privately review case progress, appeals, and blocked people",
            safetyOpen: "Open",
            achievements: "Achievements",
            achievementsBody: "Milestones for attending, hosting, and building communities sync across iOS and Web.",
            unlocked: "Unlocked",
            locked: "In progress",
            logout: "Log out",
            logoutFailed: "We could not finish signing you out. Please try again.",
            logoutAll: "Log out everywhere",
            logoutAllBody: "Revoke every iOS and Web session",
            logoutAllConfirm: "Log out on every device? You will need to sign in again.",
            notifications: "Notifications",
            analytics: "Anonymous product analytics",
            analyticsBody: "Share minimal funnel usage to improve Spott. Search text, contact details, and private content are never included.",
            saving: "Saving…",
            save: "Save changes",
            delete: "Delete account",
            deleteBody: "We check hosted events, group ownership, and wallet obligations first.",
            requestDelete: "Request deletion",
            cancelDelete: "Cancel deletion request",
            cancelDeleteConfirm: "Cancel the account deletion request?",
            deleteCancelled: "Account deletion request cancelled.",
            loading: "Syncing profile and notification preferences…",
            confirmDelete:
              "Request account deletion? We first check unfinished events and group ownership, then begin the cooling-off period.",
            deleteRecorded: "Deletion request recorded. Earliest execution",
          }
        : {
            title: "资料与设置",
            syncing: "同步中",
            connected: "已连接云端",
            public: "公开资料",
            avatar: "头像",
            avatarBody: "图片完成病毒扫描和内容安全处理后，会同时更新 iOS 与 Web。",
            avatarChange: "选择图片",
            avatarSaved: "头像已更新。",
            nickname: "昵称",
            bio: "简介",
            region: "常用地区",
            interface: "界面语言",
            content: "希望看到的活动内容语言",
            identity: "身份与安全",
            mergeAccount: "合并另一个账号",
            mergeBody: "重新验证另一个现有账号，先查看影响和冲突，再最终确认合并。",
            mergeAction: "安全合并",
            phone: "日本手机号",
            phoneVerified: "已验证 · 号码不会公开",
            phoneNeeded: "报名、发布与群组操作前需要验证",
            verified: "已验证",
            pending: "待验证",
            session: "当前 Web 会话",
            sessionBody: "登录状态受刷新令牌轮换保护",
            safety: "安全中心",
            safetyBody: "私密查看案件进度、申诉和已拉黑用户",
            safetyOpen: "打开",
            achievements: "成就",
            achievementsBody: "参加、主办和建设社区的里程碑会在 iOS 与 Web 同步。",
            unlocked: "已获得",
            locked: "进行中",
            logout: "退出登录",
            logoutFailed: "暂时无法完成退出，请重试。",
            logoutAll: "退出所有设备",
            logoutAllBody: "撤销全部 iOS 与 Web 登录会话",
            logoutAllConfirm: "确定退出所有设备吗？之后需要重新登录。",
            notifications: "通知",
            analytics: "匿名产品体验分析",
            analyticsBody: "仅共享改进核心流程所需的最少使用情况，不会发送搜索文字、联系方式或私密内容。",
            saving: "正在保存…",
            save: "保存更改",
            delete: "注销账号",
            deleteBody: "申请前会检查主办活动、群组所有权和钱包责任。",
            requestDelete: "申请注销",
            cancelDelete: "撤销注销申请",
            cancelDeleteConfirm: "确定撤销账号注销申请吗？",
            deleteCancelled: "账号注销申请已撤销。",
            loading: "正在同步资料和通知偏好…",
            confirmDelete: "确定申请注销账号吗？系统会先检查未结束活动和群主责任，并进入冷静期。",
            deleteRecorded: "注销申请已记录，最早执行时间",
          };

  async function save() {
    if (!profile) return;
    setBusy(true);
    setMessage("");
    try {
      const updated = await apiRequest<Profile>("/me/profile", {
        method: "PATCH",
        authenticated: true,
        ifMatch: profile.version,
        body: JSON.stringify({
          nickname: profile.nickname,
          bio: profile.bio,
          regionId: profile.regionId,
          preferredLocale,
          contentLanguages,
        }),
      });
      await Promise.all(
        notificationTypes.map((type) =>
          apiRequest(`/notifications/preferences/${type}`, {
            method: "PUT",
            authenticated: true,
            body: JSON.stringify({
              inApp: prefs[type] ?? true,
              push: prefs[type] ?? true,
              email: false,
              quietStart: "22:00",
              quietEnd: "08:00",
              locale: preferredLocale,
            }),
          }),
        ),
      );
      setProfile(updated);
      applyInterfaceLocale(preferredLocale);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(file: File) {
    if (!profile) return;
    setAvatarBusy(true);
    setMessage("");
    try {
      const result = await uploadProcessedImage<{ url: string; version: number }>({
        file,
        purpose: "profile_avatar",
        attachPath: (assetId) => `/media/${assetId}/attach/profile`,
      });
      setProfile({ ...profile, avatarURL: result.url, version: result.version });
      setMessage(copy.avatarSaved);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function logout() {
    setMessage("");
    const completed = await logoutCurrentSession("current");
    if (!completed) {
      setMessage(copy.logoutFailed);
      return;
    }
    window.location.assign("/");
  }

  async function logoutEverywhere() {
    await appDialog.run({
      title: copy.logoutAll,
      message: copy.logoutAllConfirm,
      confirmLabel: copy.logoutAll,
      destructive: true,
      onConfirm: async () => {
        setMessage("");
        const completed = await logoutCurrentSession("all");
        if (!completed) {
          const error = new Error(copy.logoutFailed);
          setMessage(error.message);
          throw error;
        }
        window.location.assign("/");
      },
    });
  }

  async function requestDeletion() {
    await appDialog.run({
      title: copy.requestDelete,
      message: copy.confirmDelete,
      confirmLabel: copy.requestDelete,
      destructive: true,
      onConfirm: async () => {
        try {
          const result = await apiRequest<{ executeAfter: string }>("/accounts/deletion-request", {
            method: "POST",
            authenticated: true,
            idempotent: true,
          });
          setMessage(
            `${copy.deleteRecorded}: ${new Intl.DateTimeFormat(intlLocale(locale), {
              dateStyle: "long",
              timeStyle: "short",
            }).format(new Date(result.executeAfter))}`,
          );
          setDeletionPending(true);
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  async function cancelDeletion() {
    await appDialog.run({
      title: copy.cancelDelete,
      message: copy.cancelDeleteConfirm,
      confirmLabel: copy.cancelDelete,
      onConfirm: async () => {
        try {
          await apiRequest("/accounts/deletion-request", {
            method: "DELETE",
            authenticated: true,
          });
          setDeletionPending(false);
          setMessage(copy.deleteCancelled);
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  const phoneVerified = readSession()?.user.phoneVerified ?? false;

  return (
    <main className="dashboard-shell">
      <DashboardNav current="settings" />
      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">
              PROFILE / {profile ? `VERSION ${profile.version}` : "SYNCING"}
            </span>
            <h1>{copy.title}</h1>
          </div>
          <span className="sync-badge">
            <i /> {busy ? copy.syncing : copy.connected}
          </span>
        </div>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        {profile ? (
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="settings-section">
              <h2>{copy.public}</h2>
              <div className="profile-photo-editor">
                {profile.avatarURL ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.avatarURL} alt="" />
                ) : (
                  <span aria-hidden="true">{profile.nickname.slice(0, 1).toUpperCase()}</span>
                )}
                <div>
                  <strong>{copy.avatar}</strong>
                  <p>{copy.avatarBody}</p>
                  <label className="secondary-action compact">
                    {avatarBusy ? copy.saving : copy.avatarChange}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic"
                      disabled={avatarBusy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadAvatar(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>
              <label className="form-field">
                {copy.nickname}
                <input
                  value={profile.nickname}
                  onChange={(event) => setProfile({ ...profile, nickname: event.target.value })}
                  maxLength={40}
                  required
                />
              </label>
              <label className="form-field">
                {copy.bio}
                <textarea
                  value={profile.bio}
                  onChange={(event) => setProfile({ ...profile, bio: event.target.value })}
                  maxLength={500}
                />
              </label>
              <label className="form-field">
                {copy.region}
                <select
                  value={profile.regionId}
                  onChange={(event) => setProfile({ ...profile, regionId: event.target.value })}
                >
                  {regions.map(([value, zh, ja, en]) => (
                    <option key={value} value={value}>
                      {locale === "ja" ? ja : locale === "en" ? en : zh}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                {copy.interface}
                <select
                  value={preferredLocale}
                  onChange={(event) =>
                    setPreferredLocale(event.target.value as Preference["locale"])
                  }
                >
                  {(Object.keys(localeNames) as Locale[]).map((value) => (
                    <option key={value} value={value}>
                      {localeNames[value]}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="language-preferences">
                <legend>{copy.content}</legend>
                {(Object.keys(localeNames) as Locale[]).map((value) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={contentLanguages.includes(value)}
                      onChange={(event) =>
                        setContentLanguages((current) =>
                          event.target.checked
                            ? [...new Set([...current, value])]
                            : current.length > 1
                              ? current.filter((item) => item !== value)
                              : current,
                        )
                      }
                    />
                    {localeNames[value]}
                  </label>
                ))}
              </fieldset>
            </div>

            <div className="settings-section">
              <h2>{copy.achievements}</h2>
              <p className="achievement-intro">{copy.achievementsBody}</p>
              <div className="achievement-grid">
                {achievementDefinitions.map((definition) => {
                  const award = achievements.find((item) => item.code === definition.code);
                  const current = achievementProgress?.[definition.metric] ?? 0;
                  const progress = Math.min(100, (current / definition.threshold) * 100);
                  const labels = achievementLabel(definition.code, locale);
                  return (
                    <article className={award ? "unlocked" : ""} key={definition.code}>
                      <div className="achievement-mark" aria-hidden="true">
                        {award ? "✓" : labels.symbol}
                      </div>
                      <div>
                        <span>{award ? copy.unlocked : copy.locked}</span>
                        <strong>{labels.title}</strong>
                        <p>{labels.body}</p>
                      </div>
                      <div className="achievement-progress">
                        <i>
                          <b style={{ width: `${award ? 100 : progress}%` }} />
                        </i>
                        <small>
                          {award
                            ? new Intl.DateTimeFormat(intlLocale(locale), {
                                dateStyle: "medium",
                              }).format(new Date(award.awardedAt))
                            : `${Math.min(current, definition.threshold)} / ${definition.threshold}`}
                        </small>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className="settings-section">
              <h2>{copy.identity}</h2>
              <div className="setting-row">
                <div>
                  <strong>{copy.phone}</strong>
                  <p>{phoneVerified ? copy.phoneVerified : copy.phoneNeeded}</p>
                </div>
                <span className={phoneVerified ? "verified-badge" : "pending-badge"}>
                  {phoneVerified ? copy.verified : copy.pending}
                </span>
              </div>
              <div className="setting-row">
                <div>
                  <strong>{copy.session}</strong>
                  <p>{copy.sessionBody}</p>
                </div>
                <button type="button" onClick={() => void logout()}>
                  {copy.logout}
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>{copy.safety}</strong>
                  <p>{copy.safetyBody}</p>
                </div>
                <Link href="/safety">{copy.safetyOpen} ↗</Link>
              </div>
              <div className="setting-row">
                <div>
                  <strong>{copy.mergeAccount}</strong>
                  <p>{copy.mergeBody}</p>
                </div>
                <Link href="/me/account-merge">{copy.mergeAction} ↗</Link>
              </div>
              <div className="setting-row">
                <div>
                  <strong>{copy.logoutAll}</strong>
                  <p>{copy.logoutAllBody}</p>
                </div>
                <button type="button" onClick={() => void logoutEverywhere()}>
                  {copy.logoutAll}
                </button>
              </div>
            </div>

            <div className="settings-section">
              <h2>{copy.notifications}</h2>
              <label className="toggle-row">
                <span>
                  <strong>{copy.analytics}</strong>
                  <small>{copy.analyticsBody}</small>
                </span>
                <input
                  type="checkbox"
                  checked={analyticsEnabled}
                  onChange={(event) => {
                    const granted = event.target.checked;
                    setAnalyticsEnabled(granted);
                    setAnalyticsConsent(granted);
                    if (granted) void trackProductEvent("analytics_consent_granted");
                  }}
                />
              </label>
              {notificationTypes.map((type) => {
                const labels = notificationLabel(type, locale);
                return (
                  <label className="toggle-row" key={type}>
                    <span>
                      <strong>{labels.title}</strong>
                      <small>{labels.detail}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={prefs[type] ?? true}
                      onChange={(event) => setPrefs({ ...prefs, [type]: event.target.checked })}
                    />
                  </label>
                );
              })}
            </div>

            <button className="primary-action compact" disabled={busy}>
              {busy ? copy.saving : copy.save}
            </button>
            <div className="danger-zone">
              <div>
                <strong>{copy.delete}</strong>
                <p>{copy.deleteBody}</p>
              </div>
              <button
                type="button"
                onClick={() => void (deletionPending ? cancelDeletion() : requestDeletion())}
              >
                {deletionPending ? copy.cancelDelete : copy.requestDelete}
              </button>
            </div>
          </form>
        ) : (
          !message && (
            <div className="loading-state">
              <span />
              <p>{copy.loading}</p>
            </div>
          )
        )}
      </section>
    </main>
  );
}

function notificationLabel(
  type: (typeof notificationTypes)[number],
  locale: Locale,
): { title: string; detail: string } {
  const labels = {
    "event.critical": [
      ["活动关键变化", "时间、地点、费用和取消"],
      ["イベントの重要な変更", "日時、場所、参加費、中止"],
      ["Important event changes", "Time, place, fees, and cancellation"],
    ],
    "registration.status": [
      ["报名与候补", "确认、拒绝、候补递补和签到"],
      ["申込とキャンセル待ち", "確定、却下、空席案内、チェックイン"],
      ["Registration & waitlist", "Confirmation, rejection, offers, and check-in"],
    ],
    "group.update": [
      ["群组更新", "公告、评论和后续活动"],
      ["グループ更新", "お知らせ、コメント、次のイベント"],
      ["Group updates", "Announcements, comments, and upcoming events"],
    ],
    recommendation: [
      ["推荐提醒", "与你的兴趣相关的新活动"],
      ["おすすめ", "興味に合う新しいイベント"],
      ["Recommendations", "New events related to your interests"],
    ],
  } as const;
  const item = labels[type][locale === "ja" ? 1 : locale === "en" ? 2 : 0];
  return { title: item[0], detail: item[1] };
}

function achievementLabel(
  code: (typeof achievementDefinitions)[number]["code"],
  locale: Locale,
): { symbol: string; title: string; body: string } {
  const labels = {
    first_checkin: [
      ["初", "第一次到场", "完成一次真实见面"],
      ["初", "はじめての参加", "最初の集まりでチェックイン"],
      ["01", "First arrival", "Check in at your first gathering"],
    ],
    city_explorer_5: [
      ["城", "城市探索者", "累计参加 5 次活动"],
      ["街", "シティエクスプローラー", "5回の集まりに参加"],
      ["05", "City explorer", "Attend five gatherings"],
    ],
    first_hosted_event: [
      ["主", "第一次主办", "完整办完一场活动"],
      ["主", "はじめての主催", "最初のイベントを完了"],
      ["H", "First hosted event", "Complete your first hosted gathering"],
    ],
    community_builder: [
      ["群", "社区建设者", "自己的群组达到 10 位成员"],
      ["輪", "コミュニティビルダー", "所有グループが10人に到達"],
      ["C", "Community builder", "Grow an owned group to ten members"],
    ],
  } as const;
  const item = labels[code][locale === "ja" ? 1 : locale === "en" ? 2 : 0];
  return { symbol: item[0], title: item[1], body: item[2] };
}

function intlLocale(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}
