'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  apiRequest,
  deviceId,
  errorMessage,
  saveSession,
  type WebSession,
} from '../lib/client-api';
import { useI18n } from '../components/I18nProvider';

interface Challenge {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  developmentCode?: string;
}

export function LoginForm({ returnTo = '/discover' }: { returnTo?: string }) {
  const { locale } = useI18n();
  const copy =
    locale === 'ja'
      ? {
          email: 'メールアドレス',
          code: '6桁の確認コード',
          sent: '確認コードを送信しました。メールをご確認ください。',
          wait: 'お待ちください…',
          verify: '確認してログイン',
          send: '確認コードを送信',
          change: 'メールを変更',
          terms:
            '続行すると、利用規約とプライバシーポリシーに同意したものとみなされます。参加・公開などには日本の電話番号認証が必要です。',
        }
      : locale === 'en'
        ? {
            email: 'Email address',
            code: '6-digit code',
            sent: 'We sent a verification code. Check your inbox.',
            wait: 'Please wait…',
            verify: 'Verify and log in',
            send: 'Send email code',
            change: 'Use another email',
            terms:
              'By continuing, you agree to the Terms and Privacy Policy. High-trust actions still require a verified Japanese phone number.',
          }
        : {
            email: '邮箱地址',
            code: '6 位验证码',
            sent: '验证码已发送，请检查邮箱。',
            wait: '请稍候…',
            verify: '验证并登录',
            send: '发送邮箱验证码',
            change: '更换邮箱',
            terms: '继续即表示你同意服务条款和隐私政策。登录后，高信任动作仍需验证日本手机号。',
          };
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (!challenge) {
        const created = await apiRequest<Challenge>('/auth/email/challenges', {
          method: 'POST',
          body: JSON.stringify({ email, deviceId: deviceId() }),
        });
        setChallenge(created);
        if (created.developmentCode) setCode(created.developmentCode);
        setMessage(copy.sent);
      } else {
        const session = await apiRequest<WebSession>('/auth/email/verify', {
          method: 'POST',
          idempotent: true,
          body: JSON.stringify({ challengeId: challenge.challengeId, code, deviceId: deviceId() }),
        });
        saveSession(session);
        const destination =
          returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/discover';
        window.location.assign(destination);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label>
        {copy.email}
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.jp"
          autoComplete="email"
          disabled={Boolean(challenge)}
        />
      </label>
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
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      <button className="primary-action" disabled={busy}>
        {busy ? copy.wait : challenge ? copy.verify : copy.send}
      </button>
      {challenge && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setChallenge(null);
            setCode('');
            setMessage('');
          }}
        >
          {copy.change}
        </button>
      )}
      <p>{copy.terms}</p>
    </form>
  );
}
