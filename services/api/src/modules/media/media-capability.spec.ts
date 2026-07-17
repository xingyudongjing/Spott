import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaCapabilityCodec } from './media-capability.js';

const prefix = 'spott-media-v1';

const payload = {
  method: 'PUT' as const,
  routePath: '/v1/media/upload-attempts/019b0000-0000-7000-8000-000000000010/content',
  attemptId: '019b0000-0000-7000-8000-000000000010',
  assetId: '019b0000-0000-7000-9000-000000000001',
  ownerId: '019b0000-0000-7000-8000-000000000002',
  generation: 3,
  mimeType: 'image/jpeg' as const,
  byteSize: 1024,
  contentSha256: 'ab'.repeat(32),
  expiresAt: Date.now() + 60_000,
};

afterEach(() => vi.unstubAllEnvs());

describe('MediaCapabilityCodec', () => {
  it('encrypts all object bindings and rejects a modified capability', () => {
    vi.stubEnv('MEDIA_GATEWAY_CAPABILITY_KEY_BASE64URL', Buffer.alloc(32, 9).toString('base64url'));
    const codec = new MediaCapabilityCodec();
    const token = codec.issue(payload);

    expect(token).not.toContain(payload.assetId);
    expect(codec.verify(token)).toEqual(payload);

    // Every single-character edit must be rejected, including edits landing on
    // the spare low bits of a segment's final base64url character.
    for (let index = prefix.length + 1; index < token.length; index += 1) {
      const original = token[index];
      if (original === '.') continue;
      const replacement = original === 'x' ? 'y' : 'x';
      const tampered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
      expect(tampered).not.toEqual(token);
      expect(() => codec.verify(tampered)).toThrowError(/上传授权无效/u);
    }
  });

  it('fails closed when the production secret is absent', () => {
    vi.stubEnv('MEDIA_GATEWAY_CAPABILITY_KEY_BASE64URL', '');
    expect(() => new MediaCapabilityCodec().issue(payload)).toThrowError(/媒体上传服务尚未配置/u);
  });
});
