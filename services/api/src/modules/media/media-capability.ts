import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { DomainError } from '@spott/domain';
import { z } from 'zod';

const capabilitySchema = z.object({
  method: z.literal('PUT'),
  routePath: z.string().regex(/^\/v1\/media\/upload-attempts\/[0-9a-f-]{36}\/content$/u),
  attemptId: z.string().uuid(),
  assetId: z.string().uuid(),
  ownerId: z.string().uuid(),
  generation: z.number().int().min(0),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  byteSize: z.number().int().min(1).max(20 * 1024 * 1024),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
});

export type MediaCapability = z.infer<typeof capabilitySchema>;

const prefix = 'spott-media-v1';
const additionalData = Buffer.from(prefix, 'utf8');

// base64url leaves spare low bits in the final character whenever the byte
// length is not a multiple of 3, so several distinct strings decode to the
// same bytes. Re-encoding proves the caller sent the one canonical form and
// keeps the token bytes in 1:1 correspondence with the token string.
function decodeCanonical(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('non-canonical base64url segment');
  }
  return decoded;
}

export class MediaCapabilityCodec {
  issue(payload: MediaCapability): string {
    const key = this.key();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(additionalData);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(capabilitySchema.parse(payload)), 'utf8'),
      cipher.final(),
    ]);
    return [prefix, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  verify(token: string): MediaCapability {
    try {
      const [tokenPrefix, nonceValue, ciphertextValue, tagValue, extra] = token.split('.');
      if (tokenPrefix !== prefix || !nonceValue || !ciphertextValue || !tagValue || extra) {
        throw new Error('invalid capability envelope');
      }
      const nonce = decodeCanonical(nonceValue);
      const ciphertext = decodeCanonical(ciphertextValue);
      const tag = decodeCanonical(tagValue);
      if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
        throw new Error('invalid capability lengths');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key(), nonce);
      decipher.setAAD(additionalData);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const payload = capabilitySchema.parse(JSON.parse(plaintext.toString('utf8')));
      if (payload.expiresAt <= Date.now()) {
        throw new DomainError(
          'MEDIA_GATEWAY_CAPABILITY_EXPIRED',
          '上传授权已过期，请安全恢复上传任务。',
          403,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'MEDIA_GATEWAY_CAPABILITY_INVALID',
        '上传授权无效。',
        403,
      );
    }
  }

  private key(): Buffer {
    const encoded = process.env.MEDIA_GATEWAY_CAPABILITY_KEY_BASE64URL;
    if (!encoded) {
      throw new DomainError(
        'MEDIA_GATEWAY_UNAVAILABLE',
        '媒体上传服务尚未配置。',
        503,
        { retryable: true },
      );
    }
    const key = Buffer.from(encoded, 'base64url');
    if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
      throw new DomainError(
        'MEDIA_GATEWAY_UNAVAILABLE',
        '媒体上传服务配置无效。',
        503,
        { retryable: false },
      );
    }
    return key;
  }
}
