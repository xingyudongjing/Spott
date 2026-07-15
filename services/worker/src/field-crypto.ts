import { createDecipheriv } from 'node:crypto';

export class FieldDecryptor {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.byteLength !== 32) throw new Error('FIELD_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  }

  decrypt(payload: Buffer): string {
    if (payload.byteLength < 29) throw new Error('encrypted field is truncated');
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  }
}
