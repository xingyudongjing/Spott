import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { renderTemplate, resolveCopy } from '../src/delivery.js';

describe('worker delivery configuration and templates', () => {
  it('renders only declared template variables', () => {
    expect(renderTemplate('{{title}} · {{event.area}} · {{missing}}', {
      title: 'Coffee walk', event: { area: '渋谷' }, raw: '<script>',
    })).toBe('Coffee walk · 渋谷 · ');
  });

  it('provides native Chinese, Japanese and English reminder copy', () => {
    const payload = { title: 'Coffee walk', startsAt: '2026-07-16 18:00' };
    expect(resolveCopy('event.reminder.24h', 'zh-Hans', payload).title).toContain('明天');
    expect(resolveCopy('event.reminder.24h', 'ja', payload).title).toContain('明日');
    expect(resolveCopy('event.reminder.24h', 'en', payload).title).toContain('tomorrow');
  });

  it('rejects fake-success providers and disabled scanning in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://spott:spott@localhost/spott',
      FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
      OBJECT_STORE_PROVIDER: 's3',
      MEDIA_SCAN_PROVIDER: 'disabled',
      EMAIL_PROVIDER: 'console',
      PUSH_PROVIDER: 'console',
    })).toThrow();
  });
});
