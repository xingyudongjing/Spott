import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { configuration } from '../config.js';

@Injectable()
export class FieldCrypto {
  private readonly key = Buffer.from(configuration().FIELD_ENCRYPTION_KEY_BASE64, 'base64');
  private readonly pepper = configuration().LOOKUP_HMAC_PEPPER;

  constructor() {
    if (this.key.byteLength !== 32) {
      throw new Error('FIELD_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
    }
  }

  encrypt(plainText: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  decrypt(payload: Buffer): string {
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  lookupHash(normalized: string): Buffer {
    return createHmac('sha256', this.pepper).update(normalized).digest();
  }
}
