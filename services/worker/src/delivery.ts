import { connect, type ClientHttp2Stream } from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import nodemailer from 'nodemailer';
import type { WorkerConfig } from './config.js';

export type NotificationLocale = 'zh-Hans' | 'zh-Hant' | 'ja' | 'en';

export interface NotificationCopy {
  title: string;
  body: string;
}

export interface PushTarget {
  id: string;
  token: string;
  environment: 'sandbox' | 'production';
}

export interface DeliveryOutcome {
  providerId?: string;
  suppressedCode?: string;
  invalidTargetIds?: string[];
}

export class DeliveryFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly invalidTargetIds: string[] = [],
  ) {
    super(code);
    this.name = 'DeliveryFailure';
  }
}

const fallbackCopy: Record<NotificationLocale, NotificationCopy> = {
  'zh-Hans': { title: 'Spott 通知', body: '你有一条新的活动动态。' },
  'zh-Hant': { title: 'Spott 通知', body: '你有一則新的活動動態。' },
  ja: { title: 'Spottからのお知らせ', body: 'イベントに新しい更新があります。' },
  en: { title: 'A new update from Spott', body: 'There is a new update for your event.' },
};

const typeCopy: Record<string, Partial<Record<NotificationLocale, NotificationCopy>>> = {
  'event.reminder.24h': {
    'zh-Hans': { title: '活动将在明天开始', body: '{{title}} · {{startsAt}}' },
    ja: { title: 'イベントは明日です', body: '{{title}} · {{startsAt}}' },
    en: { title: 'Your event starts tomorrow', body: '{{title}} · {{startsAt}}' },
  },
  'event.reminder.2h': {
    'zh-Hans': { title: '活动将在 2 小时后开始', body: '{{title}} · {{publicArea}}' },
    ja: { title: 'イベント開始まであと2時間', body: '{{title}} · {{publicArea}}' },
    en: { title: 'Your event starts in 2 hours', body: '{{title}} · {{publicArea}}' },
  },
  'waitlist.offered': {
    'zh-Hans': { title: '候补席位已为你保留', body: '请在 2 小时内确认，逾期将自动顺延。' },
    ja: { title: 'キャンセル待ちの枠をご用意しました', body: '2時間以内に参加を確定してください。' },
    en: { title: 'A waitlist spot is ready', body: 'Accept within 2 hours before it passes to the next guest.' },
  },
  'group.announcement': {
    'zh-Hans': { title: '{{groupName}} 发布了新公告', body: '{{body}}' },
    ja: { title: '{{groupName}}から新しいお知らせ', body: '{{body}}' },
    en: { title: 'New announcement from {{groupName}}', body: '{{body}}' },
  },
  'event.cancelled': {
    'zh-Hans': { title: '活动已取消', body: '{{title}} 已取消，请查看退款与后续安排。' },
    ja: { title: 'イベントが中止されました', body: '{{title}}の返金と今後の案内をご確認ください。' },
    en: { title: 'Event cancelled', body: '{{title}} was cancelled. Review refund and follow-up details.' },
  },
  'group.dissolution_scheduled': {
    'zh-Hans': { title: '{{groupName}} 将解散', body: '群组预计于 {{scheduledFor}} 解散，请及时保存需要的信息。' },
    ja: { title: '{{groupName}} は解散予定です', body: '{{scheduledFor}} に解散します。必要な情報を保存してください。' },
    en: { title: '{{groupName}} will close', body: 'The group is scheduled to close on {{scheduledFor}}.' },
  },
  'achievements.awarded': {
    'zh-Hans': { title: '你获得了新成就', body: '打开 Spott 查看刚刚解锁的徽章。' },
    ja: { title: '新しい実績を獲得しました', body: 'Spottで新しいバッジを確認しましょう。' },
    en: { title: 'You unlocked a new achievement', body: 'Open Spott to see your new badge.' },
  },
  'moderation.decided': {
    'zh-Hans': { title: '安全申诉已有处理结果', body: '请在 Spott 安全中心查看处理决定与可用操作。' },
    ja: { title: '安全性に関する審査結果があります', body: 'Spottのセーフティセンターで結果をご確認ください。' },
    en: { title: 'Your safety case was reviewed', body: 'Open the Spott Safety Center to review the decision.' },
  },
};

function valueAt(payload: Record<string, unknown>, path: string): string {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return '';
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || current === undefined) return '';
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'bigint') return String(current);
  return '';
}

export function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, path: string) => valueAt(payload, path));
}

export function resolveCopy(
  type: string,
  locale: string,
  payload: Record<string, unknown>,
  template?: NotificationCopy,
): NotificationCopy {
  const supportedLocale = (['zh-Hans', 'zh-Hant', 'ja', 'en'] as const).includes(locale as NotificationLocale)
    ? locale as NotificationLocale
    : 'zh-Hans';
  const source = template ?? typeCopy[type]?.[supportedLocale] ?? typeCopy[type]?.['zh-Hans'] ?? fallbackCopy[supportedLocale];
  const localizedPayload = localizeTemporalValues(payload, supportedLocale);
  return {
    title: renderTemplate(source.title, localizedPayload).slice(0, 160),
    body: renderTemplate(source.body, localizedPayload).slice(0, 600),
  };
}

function localizeTemporalValues(
  payload: Record<string, unknown>,
  locale: NotificationLocale,
): Record<string, unknown> {
  const localized = { ...payload };
  const intlLocale = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', ja: 'ja-JP', en: 'en-US' }[locale];
  for (const key of ['startsAt', 'expiresAt', 'scheduledFor']) {
    const value = payload[key];
    if (typeof value !== 'string') continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    localized[key] = new Intl.DateTimeFormat(intlLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tokyo',
    }).format(date);
  }
  return localized;
}

export class NotificationAdapters {
  private readonly mailer?: nodemailer.Transporter;
  private apnsKey?: CryptoKey;
  private apnsToken?: { value: string; createdAt: number };

  constructor(private readonly config: WorkerConfig) {
    if (config.EMAIL_PROVIDER === 'smtp') {
      this.mailer = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        ...(config.SMTP_USER && config.SMTP_PASSWORD
          ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
          : {}),
        connectionTimeout: 5_000,
        socketTimeout: 15_000,
      });
    }
  }

  async email(deliveryId: string, recipient: string | undefined, copy: NotificationCopy): Promise<DeliveryOutcome> {
    if (this.config.EMAIL_PROVIDER === 'disabled') return { suppressedCode: 'EMAIL_PROVIDER_DISABLED' };
    if (this.config.EMAIL_PROVIDER === 'console') {
      console.info(JSON.stringify({ event: 'notification.email.console', deliveryId, to: recipient ?? '(no-email)', ...copy }));
      return { providerId: `console-email:${deliveryId}` };
    }
    if (!recipient) throw new DeliveryFailure('RECIPIENT_EMAIL_MISSING', false);
    try {
      const result: unknown = await this.mailer!.sendMail({
        from: this.config.SMTP_FROM,
        to: recipient,
        subject: copy.title,
        text: copy.body,
      });
      const messageId = typeof result === 'object' && result !== null && 'messageId' in result && typeof result.messageId === 'string'
        ? result.messageId
        : `smtp:${deliveryId}`;
      return { providerId: messageId };
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'SMTP_SEND_FAILED';
      throw new DeliveryFailure(code, true);
    }
  }

  async push(deliveryId: string, targets: PushTarget[], copy: NotificationCopy, payload: Record<string, unknown>): Promise<DeliveryOutcome> {
    if (this.config.PUSH_PROVIDER === 'disabled') return { suppressedCode: 'PUSH_PROVIDER_DISABLED' };
    if (this.config.PUSH_PROVIDER === 'console') {
      console.info(JSON.stringify({ event: 'notification.push.console', deliveryId, targetCount: targets.length, ...copy }));
      return { providerId: `console-push:${deliveryId}` };
    }
    if (targets.length === 0) throw new DeliveryFailure('ACTIVE_DEVICE_NOT_FOUND', false);

    const successes: string[] = [];
    const invalid: string[] = [];
    const transient: string[] = [];
    const permanent: string[] = [];
    for (const target of targets) {
      try {
        successes.push(await this.sendApns(deliveryId, target, copy, payload));
      } catch (error) {
        if (error instanceof DeliveryFailure) {
          if (error.invalidTargetIds.length) invalid.push(target.id);
          else if (error.retryable) transient.push(error.code);
          else permanent.push(error.code);
        } else {
          transient.push('APNS_SEND_FAILED');
        }
      }
    }
    if (successes.length) return { providerId: successes[0]!, invalidTargetIds: invalid };
    if (transient.length) throw new DeliveryFailure(transient[0]!, true, invalid);
    if (permanent.length) throw new DeliveryFailure(permanent[0]!, false, invalid);
    throw new DeliveryFailure('APNS_ALL_TARGETS_INVALID', false, invalid);
  }

  private async apnsAuthorization(): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    if (this.apnsToken && now - this.apnsToken.createdAt < 50 * 60) return this.apnsToken.value;
    const privateKey = this.config.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKey || !this.config.APNS_TEAM_ID || !this.config.APNS_KEY_ID) {
      throw new DeliveryFailure('APNS_CREDENTIALS_MISSING', false);
    }
    this.apnsKey ??= await importPKCS8(privateKey, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.APNS_KEY_ID })
      .setIssuer(this.config.APNS_TEAM_ID)
      .setIssuedAt(now)
      .sign(this.apnsKey);
    this.apnsToken = { value, createdAt: now };
    return value;
  }

  private async sendApns(
    deliveryId: string,
    target: PushTarget,
    copy: NotificationCopy,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const origin = target.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const authorization = await this.apnsAuthorization();
    const body = JSON.stringify({
      aps: { alert: { title: copy.title, body: copy.body }, sound: 'default', 'mutable-content': 1 },
      spott: compactPushPayload(payload),
    });
    return new Promise<string>((resolve, reject) => {
      const session = connect(origin);
      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization: `bearer ${authorization}`,
        'apns-topic': this.config.APNS_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-id': deliveryId,
        'content-type': 'application/json',
      });
      let status = 0;
      let providerId = deliveryId;
      let response = '';
      const finish = (): void => session.close();
      session.setTimeout(15_000, () => {
        request.close();
        finish();
        reject(new DeliveryFailure('APNS_TIMEOUT', true));
      });
      session.once('error', (error: Error) => { finish(); reject(new DeliveryFailure(`APNS_${error.name}`, true)); });
      request.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
        providerId = String(headers['apns-id'] ?? deliveryId);
      });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { response += chunk; });
      request.once('end', () => {
        finish();
        if (status === 200) return resolve(providerId);
        let reason = 'APNS_REJECTED';
        try { reason = String((JSON.parse(response) as { reason?: string }).reason ?? reason); } catch { /* APNs can return an empty body. */ }
        const invalid = status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
        reject(new DeliveryFailure(reason, status >= 500 || status === 429, invalid ? [target.id] : []));
      });
      request.once('error', (error: Error) => { finish(); reject(new DeliveryFailure(`APNS_${error.name}`, true)); });
      request.end(body);
    });
  }
}

// Keep Node's stream type in the generated declaration surface stable across Node minor releases.
export type ApnsStream = ClientHttp2Stream;

function compactPushPayload(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const compact: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (['body', 'description', 'riskDetails'].includes(key)) continue;
    if (typeof value === 'string') compact[key] = value.slice(0, 256);
    else if (typeof value === 'number' || typeof value === 'boolean') compact[key] = value;
  }
  return compact;
}
