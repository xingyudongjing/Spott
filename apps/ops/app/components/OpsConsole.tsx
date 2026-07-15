"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  createOpsEmailChallenge,
  getOpsSession,
  logoutOpsSession,
  OpsAPIError,
  opsErrorMessage,
  verifyOpsEmailChallenge,
  type OpsEmailChallenge,
  type OpsSession,
} from "../lib/ops-api";
import { OpsIcon, type OpsIconName } from "./OpsIcon";
import { OpsWorkspace } from "./OpsWorkspaces";

export type OpsSection =
  | "overview"
  | "users"
  | "organizers"
  | "events"
  | "groups"
  | "moderation"
  | "points"
  | "config"
  | "analytics"
  | "audit"
  | "exports";

type Locale = "zh" | "ja" | "en";

const navigation: Array<{
  id: OpsSection;
  icon: OpsIconName;
  label: Record<Locale, string>;
  hint: string;
}> = [
  { id: "overview", icon: "overview", label: { zh: "态势总览", ja: "運用サマリー", en: "Overview" }, hint: "Overview" },
  { id: "users", icon: "users", label: { zh: "用户管理", ja: "ユーザー管理", en: "Users" }, hint: "Users" },
  { id: "organizers", icon: "organizers", label: { zh: "局头管理", ja: "主催者管理", en: "Organizers" }, hint: "Organizers" },
  { id: "events", icon: "events", label: { zh: "活动审核", ja: "イベント審査", en: "Event review" }, hint: "Events" },
  { id: "groups", icon: "groups", label: { zh: "群组管理", ja: "グループ管理", en: "Groups" }, hint: "Groups" },
  { id: "moderation", icon: "moderation", label: { zh: "内容安全", ja: "コンテンツ安全", en: "Safety" }, hint: "Safety" },
  { id: "points", icon: "points", label: { zh: "积分中心", ja: "ポイント管理", en: "Points" }, hint: "Points" },
  { id: "config", icon: "config", label: { zh: "运营配置", ja: "運用設定", en: "Configuration" }, hint: "Configuration" },
  { id: "analytics", icon: "analytics", label: { zh: "数据中心", ja: "データ分析", en: "Analytics" }, hint: "Analytics" },
  { id: "audit", icon: "audit", label: { zh: "权限审计", ja: "権限監査", en: "Audit" }, hint: "Audit" },
  { id: "exports", icon: "exports", label: { zh: "受控导出", ja: "制御付き出力", en: "Secure exports" }, hint: "Exports" },
];

const chrome = {
  zh: {
    skip: "跳到主要内容",
    nav: "运营导航",
    search: "搜索当前模块",
    placeholder: "案件、活动、用户或 Trace ID",
    alerts: "打开告警",
    production: "日本生产环境",
    development: "本地开发环境",
    policy: "配置由 Revision 管理",
    region: "数据范围 · 日本",
    security: "MFA 会话已验证；敏感查看与高风险写操作将要求再次验证并写入审计。",
  },
  ja: {
    skip: "メインコンテンツへ",
    nav: "運用ナビゲーション",
    search: "現在のモジュールを検索",
    placeholder: "ケース、イベント、ユーザー、Trace ID",
    alerts: "アラートを開く",
    production: "日本本番環境",
    development: "ローカル開発環境",
    policy: "設定は Revision で管理",
    region: "データ範囲・日本",
    security: "MFA セッション確認済み。機密閲覧と高リスク操作は再認証され、監査記録に残ります。",
  },
  en: {
    skip: "Skip to main content",
    nav: "Operations navigation",
    search: "Search this module",
    placeholder: "Case, event, user, or Trace ID",
    alerts: "Open alerts",
    production: "Japan production",
    development: "Local development",
    policy: "Configuration uses revisions",
    region: "Data scope · Japan",
    security: "MFA session verified. Sensitive reads and high-risk writes require reauthentication and are audited.",
  },
} satisfies Record<Locale, Record<string, string>>;

export function OpsConsole({ section }: { section: OpsSection }) {
  const [locale, setLocale] = useState<Locale>("zh");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<OpsSession | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState<unknown>(null);
  const navRef = useRef<HTMLElement>(null);
  const current = navigation.find((item) => item.id === section) ?? navigation[0]!;
  const copy = chrome[locale];

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
  }, [locale]);

  useEffect(() => {
    let active = true;
    getOpsSession()
      .then((value) => {
        if (!active) return;
        setSession(value);
        setSessionError(null);
        setSessionState("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setSession(null);
        setSessionError(cause);
        setSessionState("error");
      });
    return () => { active = false; };
  }, []);

  async function refreshSession() {
    setSessionState("loading");
    try {
      const value = await getOpsSession();
      setSession(value);
      setSessionError(null);
      setSessionState("ready");
    } catch (cause) {
      setSession(null);
      setSessionError(cause);
      setSessionState("error");
    }
  }

  async function logout() {
    try { await logoutOpsSession(); } catch { /* Local dev headers may not own a cookie session. */ }
    setSession(null);
    setSessionError(new OpsAPIError(401, "OPS_SESSION_ENDED", "运营会话已退出。"));
    setSessionState("error");
  }

  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({
      left: Math.max(0, active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2),
      behavior: "auto",
    });
  }, [section]);

  useEffect(() => {
    function requireAuthentication(event: Event) {
      setSession(null);
      setSessionError(event instanceof CustomEvent ? event.detail : null);
      setSessionState("error");
    }
    window.addEventListener("spott:ops-auth-required", requireAuthentication);
    return () => window.removeEventListener("spott:ops-auth-required", requireAuthentication);
  }, []);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(searchDraft.trim());
  }

  return (
    <div className="ops-shell">
      <a className="skip-link" href="#main">{copy.skip}</a>
      <aside className="rail" aria-label={copy.nav}>
        <Link className="brand-block" href="/" aria-label="Spott Control Room">
          <strong>SPOTT</strong>
          <span>CONTROL ROOM</span>
        </Link>
        <nav ref={navRef}>
          {navigation.map((item) => (
            <Link
              aria-current={item.id === section ? "page" : undefined}
              aria-label={item.label[locale]}
              title={item.label[locale]}
              className={item.id === section ? "nav-item active" : "nav-item"}
              href={item.id === "overview" ? "/" : `/ops/${item.id}`}
              key={item.id}
            >
              <span className="nav-glyph"><OpsIcon name={item.icon} /></span>
              <span className="nav-copy"><b>{item.label[locale]}</b><small>{item.hint}</small></span>
            </Link>
          ))}
        </nav>
        <div className="rail-footer">
          <span className="environment"><span className="status-dot" />{process.env.NODE_ENV === "development" ? copy.development : copy.production}</span>
          <p>{copy.policy}</p>
          <p>{copy.region}</p>
        </div>
      </aside>

      <main id="main" className="main-area">
        <header className="topbar">
          <div className="page-title">
            <p>OPERATIONS / {current.hint.toUpperCase()}</p>
            <h1>{current.label[locale]}</h1>
          </div>
          <div className="top-actions">
            <form className="search-box" role="search" onSubmit={submitSearch}>
              <OpsIcon name="search" />
              <label className="sr-only" htmlFor="ops-search">{copy.search}</label>
              <input id="ops-search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder={copy.placeholder} />
              {searchDraft && <button className="clear-search" type="button" aria-label="清除搜索" onClick={() => { setSearchDraft(""); setQuery(""); }}><OpsIcon name="close" /></button>}
            </form>
            <div className="locale-switch" aria-label="Language">
              <OpsIcon name="language" />
              {(["zh", "ja", "en"] as const).map((value) => <button key={value} type="button" aria-pressed={locale === value} onClick={() => setLocale(value)}>{value === "zh" ? "中" : value === "ja" ? "日" : "EN"}</button>)}
            </div>
            <Link className="icon-button" href="/ops/moderation" aria-label={copy.alerts}>
              <OpsIcon name="bell" />
            </Link>
            <div className="operator-chip" aria-label={`${session?.label ?? "Operator"}，${sessionState === "ready" && session?.mfaEnrolled ? "MFA 已验证" : "MFA 状态未验证"}`}>
              <span>{initials(session?.label ?? "OP")}</span><div><b>{session?.label ?? "Operator"}</b><small>{sessionState === "loading" ? "VERIFYING" : sessionState === "error" ? "SESSION ERROR" : session?.mfaEnrolled ? `MFA · ${Math.max(0, Math.floor(session.mfaAgeSeconds / 60))}m` : "MFA REQUIRED"}</small></div>
            </div>
            {sessionState === "ready" && <button className="logout-button" type="button" onClick={logout}>退出</button>}
          </div>
        </header>

        <div className="security-strip" role="status">
          <OpsIcon name="shield" />
          <span>{notice ?? sessionSecurityMessage(locale, sessionState, session, copy.security)}</span>
          {sessionState === "error" && <button type="button" onClick={() => refreshSession()}>重新验证</button>}
        </div>

        <section className="content-frame" aria-live="polite">
          {sessionState === "ready" && session
            ? <OpsWorkspace section={section} query={query} onNotice={setNotice} session={session} />
            : sessionState === "error"
              ? <OpsAccessGate error={sessionError} onRetry={refreshSession} onAuthenticated={(value) => { setSession(value); setSessionError(null); setSessionState("ready"); }} />
              : <div className="session-loading" role="status"><OpsIcon name="shield" /><span>正在建立安全运营会话…</span></div>}
        </section>
      </main>
    </div>
  );
}

function OpsAccessGate({
  error,
  onRetry,
  onAuthenticated,
}: {
  error: unknown;
  onRetry: () => void;
  onAuthenticated: (session: OpsSession) => void;
}) {
  const [challenge, setChallenge] = useState<OpsEmailChallenge | null>(null);
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isForbidden = error instanceof OpsAPIError && error.kind === "forbidden";

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const next = await createOpsEmailChallenge(email.trim(), opsDeviceId());
      setChallenge(next);
    } catch (cause) { setFormError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setFormError(null);
    try {
      await verifyOpsEmailChallenge(challenge.challengeId, String(form.get("code")), opsDeviceId());
      onAuthenticated(await getOpsSession());
    } catch (cause) { setFormError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }

  return <section className="access-gate" aria-labelledby="access-title"><div className="access-mark"><OpsIcon name="shield" /></div><p>SPOTT CONTROL ROOM</p><h2 id="access-title">验证运营身份</h2><span>独立短会话 · MFA 权限校验 · 所有敏感操作留痕</span>{Boolean(error) && <div className="access-error" role="alert"><b>{isForbidden ? "当前身份没有运营权限" : "安全会话需要重新验证"}</b><small>{opsErrorMessage(error)}</small></div>}{challenge ? <form onSubmit={verifyCode}><label>发送至 {email} 的 6 位验证码<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>{challenge.developmentCode && <p className="development-code">仅本地开发验证码：<code>{challenge.developmentCode}</code></p>}<button className="primary-button" disabled={submitting} type="submit">{submitting ? "验证中" : "验证并进入"}</button><button type="button" disabled={submitting} onClick={() => { setChallenge(null); setFormError(null); }}>更换邮箱</button></form> : <form onSubmit={sendCode}><label>运营账号邮箱<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="name@spott.jp" /></label><button className="primary-button" disabled={submitting} type="submit">{submitting ? "发送中" : "发送一次性验证码"}</button><button type="button" disabled={submitting} onClick={onRetry}>重试现有会话</button></form>}{formError && <p className="form-error" role="alert">{formError}</p>}<small>验证码 10 分钟有效；连续失败会触发限流。未登记运营权限或 MFA 的身份无法进入。</small></section>;
}

function opsDeviceId(): string {
  const key = "spott.ops.device-id";
  const existing = window.localStorage.getItem(key);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const next = crypto.randomUUID();
  window.localStorage.setItem(key, next);
  return next;
}

function sessionSecurityMessage(
  locale: Locale,
  sessionState: "loading" | "ready" | "error",
  session: OpsSession | null,
  verifiedCopy: string,
): string {
  if (sessionState === "loading") return locale === "zh" ? "正在验证运营会话与权限…" : locale === "ja" ? "運用セッションと権限を確認中…" : "Verifying the operations session and permissions…";
  if (sessionState === "error") return locale === "zh" ? "无法验证运营会话；所有高风险操作已锁定。" : locale === "ja" ? "運用セッションを確認できません。高リスク操作はロックされています。" : "The operations session could not be verified. High-risk actions are locked.";
  if (!session?.mfaEnrolled) return locale === "zh" ? "此会话尚未完成 MFA；所有高风险操作已锁定。" : locale === "ja" ? "MFA が未完了です。高リスク操作はロックされています。" : "MFA is not enrolled for this session. High-risk actions are locked.";
  if (session.reauthRequiredFor.length > 0) {
    const actions = session.reauthRequiredFor.join(" · ");
    return locale === "zh" ? `MFA 会话已验证；${actions} 需要重新验证。` : locale === "ja" ? `MFA セッション確認済み。${actions} は再認証が必要です。` : `MFA session verified. Reauthentication is required for ${actions}.`;
  }
  return verifiedCopy;
}

function initials(value: string): string {
  return value.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "OP";
}
