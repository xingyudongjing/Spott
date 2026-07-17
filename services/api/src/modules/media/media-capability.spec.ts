import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaCapabilityCodec } from './media-capability.js';

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
    expect(() => codec.verify(`${token.slice(0, -1)}x`)).toThrowError(/上传授权无效/u);
  });

  it('fails closed when the production secret is absent', () => {
    vi.stubEnv('MEDIA_GATEWAY_CAPABILITY_KEY_BASE64URL', '');
    expect(() => new MediaCapabilityCodec().issue(payload)).toThrowError(/媒体上传服务尚未配置/u);
  });
});
