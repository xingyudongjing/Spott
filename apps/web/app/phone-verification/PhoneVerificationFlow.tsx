'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  apiRequest,
  deviceId,
  errorMessage,
  readSession,
  refreshCurrentSession,
} from '../lib/client-api';
import { safeReturnTo } from '../lib/safe-return-to';
import { useI18n } from '../components/I18nProvider';

interface PhoneChallenge {
  challengeId: string;
  expiresAt: string;
  developmentCode?: string;
}

export function PhoneVerificationFlow({ returnTo = '/discover' }: { returnTo?: string }) {
  const { locale } = useI18n();
  const copy =
    locale === 'ja'
      ? { title: '日本の電話番号を確認', lead: '参加、公開、安全に関わる操作の前だけ確認します。番号は暗号化され、主催者には表示されません。', code: '6桁の確認コード', sent: '確認コードを送信しました。番号はアカウントの信頼性と安全確認にのみ使用します。', wait: 'お待ちください…', verify: '確認して続行', send: '6桁のコードを送信', change: '電話番号を変更', privacy: 'コードは10分間有効です。5回連続で間違えると30分間停止します。初回の確認完了時はルールに基づくポイントが付与されます。' }
      : locale === 'en'
        ? { title: 'Verify a Japanese phone number', lead: 'Required only before registration, publishing, and sensitive safety actions. Your number is encrypted and never shown to hosts.', code: '6-digit code', sent: 'Code sent. Your number is used only for account trust and safety checks.', wait: 'Please wait…', verify: 'Verify and continue', send: 'Send 6-digit code', change: 'Use another number', privacy: 'Codes expire in 10 minutes. Five failed attempts pause verification for 30 minutes. First verification earns the reward defined by the current product rules.' }
        : { title: '验证日本手机号', lead: '只在报名、发布和安全操作前验证。号码会加密保存，不向主办方展示。', code: '6 位验证码', sent: '验证码已发送。号码只用于账户信任与安全校验。', wait: '请稍候…', verify: '验证并继续', send: '发送 6 位验证码', change: '更换手机号', privacy: '验证码 10 分钟有效；连续错误 5 次后暂停 30 分钟。首次完成验证会获得产品规则规定的奖励积分。' };
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<PhoneChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const session = readSession();
    if (!session)
      window.location.replace(
        `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    else if (session.user.phoneVerified) window.location.replace(safeReturnTo(returnTo));
  }, [returnTo]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (!challenge) {
        const digits = phone.replace(/\D/g, '');
        const national = digits.startsWith('81') ? digits.slice(2) : digits.replace(/^0/, '');
        const phoneNumber = `+81${national}`;
        const created = await apiRequest<PhoneChallenge>('/phone/challenges', {
          method: 'POST',
          authenticated: true,
          body: JSON.stringify({ phoneNumber, deviceId: deviceId() }),
        });
        setChallenge(created);
        if (created.developmentCode) setCode(created.developmentCode);
        setMessage(copy.sent);
      } else {
        await apiRequest(`/phone/challenges/${challenge.challengeId}/verify`, {
          method: 'POST',
          authenticated: true,
          idempotent: true,
          body: JSON.stringify({ code }),
        });
        await refreshCurrentSession();
        window.location.assign(safeReturnTo(returnTo));
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flow-page">
      <div className="flow-shell narrow">
        <div className="flow-progress">
          <span className="active" />
          <span className="active" />
          <span />
        </div>
        <form className="flow-card" onSubmit={submit}>
          <span className="section-number">TRUST / +81</span>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
          {!challenge ? (
            <label className="phone-input">
              <span>+81</span>
              <input
                type="tel"
                inputMode="numeric"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="90 1234 5678"
                autoComplete="tel-national"
              />
            </label>
          ) : (
            <label className="form-field">
              {copy.code}
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
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
              className="text-button"
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setMessage('');
              }}
            >
              {copy.change}
            </button>
          )}
          <p className="privacy-inline">{copy.privacy}</p>
        </form>
      </div>
    </main>
  );
}
