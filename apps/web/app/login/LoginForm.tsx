'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  APIError,
  apiRequest,
  deviceId,
  errorMessage,
  saveSession,
  type WebSession,
} from '../lib/client-api';
import { safeReturnTo } from '../lib/safe-return-to';
import { useI18n } from '../components/I18nProvider';

interface Challenge {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  developmentCode?: string;
}

type Mode = 'login' | 'register';

const COPY = {
  'zh-Hans': {
    tabsLabel: '登录或注册',
    tabLogin: '登录',
    tabRegister: '注册',
    email: '邮箱地址',
    password: '密码',
    passwordLoginPlaceholder: '输入密码',
    passwordRegisterPlaceholder: '至少 8 个字符',
    nickname: '昵称（可选）',
    nicknamePlaceholder: '想让大家怎么称呼你',
    strengthHint: '至少 8 个字符；混合大小写、数字或符号更安全。',
    strengthLabels: ['', '太短', '中等', '较强'],
    submitLogin: '登录',
    submitRegister: '创建账号',
    wait: '请稍候…',
    invalidCredentials: '邮箱或密码不正确。',
    emailTaken: '该邮箱已注册，请直接登录。',
    goLogin: '去登录',
    passwordTooShort: '密码至少需要 8 个字符。',
    emailRequired: '请先填写邮箱地址。',
    otherMethods: '其他登录方式',
    otpIntro: '不想用密码？我们把一次性验证码发到你的邮箱。',
    code: '6 位验证码',
    sent: '验证码已发送，请检查邮箱。',
    send: '发送邮箱验证码',
    verify: '验证并登录',
    change: '更换邮箱',
    termsPrefix: '继续即表示你同意',
    terms: '服务条款',
    termsJoin: '和',
    privacy: '隐私政策',
    termsSuffix: '。登录后，高信任动作仍需验证日本手机号。',
  },
  ja: {
    tabsLabel: 'ログインまたは新規登録',
    tabLogin: 'ログイン',
    tabRegister: '新規登録',
    email: 'メールアドレス',
    password: 'パスワード',
    passwordLoginPlaceholder: 'パスワードを入力',
    passwordRegisterPlaceholder: '8文字以上',
    nickname: 'ニックネーム（任意）',
    nicknamePlaceholder: '表示したい名前',
    strengthHint: '8文字以上。大文字・小文字・数字や記号を混ぜるとより安全です。',
    strengthLabels: ['', '短すぎます', '普通', '強い'],
    submitLogin: 'ログイン',
    submitRegister: 'アカウントを作成',
    wait: 'お待ちください…',
    invalidCredentials: 'メールアドレスまたはパスワードが正しくありません。',
    emailTaken: 'このメールアドレスは登録済みです。ログインしてください。',
    goLogin: 'ログインへ',
    passwordTooShort: 'パスワードは8文字以上で入力してください。',
    emailRequired: 'まずメールアドレスを入力してください。',
    otherMethods: 'その他のログイン方法',
    otpIntro: 'パスワードなしで、メールに届く確認コードでログインできます。',
    code: '6桁の確認コード',
    sent: '確認コードを送信しました。メールをご確認ください。',
    send: '確認コードを送信',
    verify: '確認してログイン',
    change: 'メールを変更',
    termsPrefix: '続行すると、',
    terms: '利用規約',
    termsJoin: 'と',
    privacy: 'プライバシーポリシー',
    termsSuffix: 'に同意したものとみなされます。参加・公開などには日本の電話番号認証が必要です。',
  },
  en: {
    tabsLabel: 'Log in or sign up',
    tabLogin: 'Log in',
    tabRegister: 'Sign up',
    email: 'Email address',
    password: 'Password',
    passwordLoginPlaceholder: 'Enter your password',
    passwordRegisterPlaceholder: 'At least 8 characters',
    nickname: 'Nickname (optional)',
    nicknamePlaceholder: 'What should we call you?',
    strengthHint: 'At least 8 characters. Mixing cases, numbers, or symbols makes it stronger.',
    strengthLabels: ['', 'Too short', 'Fair', 'Strong'],
    submitLogin: 'Log in',
    submitRegister: 'Create account',
    wait: 'Please wait…',
    invalidCredentials: 'Incorrect email or password.',
    emailTaken: 'This email is already registered. Log in instead.',
    goLogin: 'Go to log in',
    passwordTooShort: 'Password must be at least 8 characters.',
    emailRequired: 'Enter your email address first.',
    otherMethods: 'Other ways to log in',
    otpIntro: 'Prefer no password? We can email you a one-time code.',
    code: '6-digit code',
    sent: 'We sent a verification code. Check your inbox.',
    send: 'Send email code',
    verify: 'Verify and log in',
    change: 'Use another email',
    termsPrefix: 'By continuing, you agree to the ',
    terms: 'Terms',
    termsJoin: ' and ',
    privacy: 'Privacy Policy',
    termsSuffix: '. High-trust actions still require a verified Japanese phone number.',
  },
} as const;

/**
 * 0 = empty, 1 = below the 8-character server minimum, 2 = acceptable,
 * 3 = long and mixed enough to be comfortable.
 */
function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (password.length === 0) return 0;
  if (password.length < 8) return 1;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if ((password.length >= 12 && classes >= 3) || (password.length >= 10 && classes >= 4)) return 3;
  return 2;
}

export function LoginForm({ returnTo = '/discover' }: { returnTo?: string }) {
  const { locale } = useI18n();
  const copy = COPY[locale] ?? COPY['zh-Hans'];
  const emailErrorId = useId();
  const passwordErrorId = useId();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpMessage, setOtpMessage] = useState('');

  const strength = passwordStrength(password);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setFormError('');
    setFieldErrors({});
  }

  /** Mirrors the email-OTP verify success path: persist, then leave via safe returnTo. */
  function completeLogin(session: WebSession) {
    saveSession(session);
    window.location.assign(safeReturnTo(returnTo));
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError('');
    setFieldErrors({});
    if (mode === 'register' && password.length < 8) {
      setFieldErrors({ password: copy.passwordTooShort });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string> = { email, password, deviceId: deviceId() };
      if (mode === 'register' && nickname.trim()) body.nickname = nickname.trim();
      const session = await apiRequest<WebSession>(
        mode === 'register' ? '/auth/password/register' : '/auth/password/login',
        { method: 'POST', idempotent: true, body: JSON.stringify(body) },
      );
      completeLogin(session);
    } catch (error) {
      if (error instanceof APIError && error.body.code === 'INVALID_CREDENTIALS') {
        setFieldErrors({ password: copy.invalidCredentials });
      } else if (error instanceof APIError && error.body.code === 'EMAIL_ALREADY_REGISTERED') {
        setFieldErrors({ email: copy.emailTaken });
      } else {
        setFormError(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(event: FormEvent) {
    event.preventDefault();
    if (otpBusy) return;
    setOtpMessage('');
    if (!challenge && !email) {
      setFieldErrors({ email: copy.emailRequired });
      return;
    }
    setOtpBusy(true);
    try {
      if (!challenge) {
        const created = await apiRequest<Challenge>('/auth/email/challenges', {
          method: 'POST',
          body: JSON.stringify({ email, deviceId: deviceId() }),
        });
        setChallenge(created);
        if (created.developmentCode) setCode(created.developmentCode);
        setOtpMessage(copy.sent);
      } else {
        const session = await apiRequest<WebSession>('/auth/email/verify', {
          method: 'POST',
          idempotent: true,
          body: JSON.stringify({ challengeId: challenge.challengeId, code, deviceId: deviceId() }),
        });
        completeLogin(session);
      }
    } catch (error) {
      setOtpMessage(errorMessage(error));
    } finally {
      setOtpBusy(false);
    }
  }

  return (
    <div className="auth-forms">
      <div className="auth-mode-tabs" role="tablist" aria-label={copy.tabsLabel}>
        <button
          type="button"
          role="tab"
          id="auth-tab-login"
          aria-selected={mode === 'login'}
          className={mode === 'login' ? 'active' : undefined}
          onClick={() => switchMode('login')}
        >
          {copy.tabLogin}
        </button>
        <button
          type="button"
          role="tab"
          id="auth-tab-register"
          aria-selected={mode === 'register'}
          className={mode === 'register' ? 'active' : undefined}
          onClick={() => switchMode('register')}
        >
          {copy.tabRegister}
        </button>
      </div>

      <form
        className="login-form"
        onSubmit={submitPassword}
        role="tabpanel"
        aria-labelledby={mode === 'login' ? 'auth-tab-login' : 'auth-tab-register'}
      >
        <label>
          {copy.email}
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.jp"
            autoComplete="email"
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? emailErrorId : undefined}
          />
          {fieldErrors.email && (
            <small className="field-error" id={emailErrorId} role="alert">
              {fieldErrors.email}
            </small>
          )}
        </label>
        {fieldErrors.email === copy.emailTaken && mode === 'register' && (
          <button
            type="button"
            className="text-button auth-switch-hint"
            onClick={() => switchMode('login')}
          >
            {copy.goLogin}
          </button>
        )}
        {mode === 'register' && (
          <label>
            {copy.nickname}
            <input
              type="text"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={copy.nicknamePlaceholder}
              autoComplete="nickname"
              maxLength={40}
            />
          </label>
        )}
        <label>
          {copy.password}
          <input
            type="password"
            required
            minLength={mode === 'register' ? 8 : 1}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={
              mode === 'register' ? copy.passwordRegisterPlaceholder : copy.passwordLoginPlaceholder
            }
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? passwordErrorId : undefined}
          />
          {fieldErrors.password && (
            <small className="field-error" id={passwordErrorId} role="alert">
              {fieldErrors.password}
            </small>
          )}
        </label>
        {mode === 'register' && (
          <div className="password-strength" data-level={strength}>
            <span className="password-strength-bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <small role="status">
              {strength > 0 && <strong>{copy.strengthLabels[strength]} · </strong>}
              {copy.strengthHint}
            </small>
          </div>
        )}
        {formError && (
          <p className="form-message form-message-error" role="alert">
            {formError}
          </p>
        )}
        <button className="primary-action" disabled={busy} aria-busy={busy || undefined}>
          {busy ? copy.wait : mode === 'register' ? copy.submitRegister : copy.submitLogin}
        </button>
      </form>

      <details className="login-alt">
        <summary>{copy.otherMethods}</summary>
        <form className="login-form" onSubmit={submitOtp}>
          <p className="login-hint">{copy.otpIntro}</p>
          {challenge && (
            <label>
              {copy.code}
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                autoComplete="one-time-code"
                autoFocus
              />
            </label>
          )}
          {otpMessage && (
            <p className="form-message" role="status">
              {otpMessage}
            </p>
          )}
          <button
            className={challenge ? 'primary-action' : 'secondary-action'}
            disabled={otpBusy}
            aria-busy={otpBusy || undefined}
          >
            {otpBusy ? copy.wait : challenge ? copy.verify : copy.send}
          </button>
          {challenge && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setOtpMessage('');
              }}
            >
              {copy.change}
            </button>
          )}
        </form>
      </details>

      <p className="login-legal">
        {copy.termsPrefix}
        <Link href="/terms">{copy.terms}</Link>
        {copy.termsJoin}
        <Link href="/privacy">{copy.privacy}</Link>
        {copy.termsSuffix}
      </p>
    </div>
  );
}
