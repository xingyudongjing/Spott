import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MEDIA_UPLOAD_BYTES, MediaObjectStore } from './media-object-store.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spott-media-test-'));
  vi.stubEnv('MEDIA_OBJECT_STORE_PROVIDER', 's3');
  vi.stubEnv('MEDIA_S3_BUCKET', 'spott-test');
  vi.stubEnv('MEDIA_S3_REGION', 'ap-northeast-1');
  vi.stubEnv('MEDIA_GATEWAY_TEMP_DIRECTORY', directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('MediaObjectStore.receiveIncoming', () => {
  it('streams exact bytes to a mode-0600 file and recomputes SHA-256 itself', async () => {
    const bytes = Buffer.from('trusted bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const store = new MediaObjectStore();
    const receipt = await store.receiveIncoming({
      stream: Readable.from(bytes),
      attemptId: randomUUID(),
      leaseId: randomUUID(),
      byteSize: bytes.byteLength,
      contentSha256: hash,
      remainingDeadlineMs: 5_000,
    });

    expect(await readFile(receipt.path)).toEqual(bytes);
    expect((await stat(receipt.path)).mode & 0o777).toBe(0o600);
    expect((await stat(receipt.manifestPath)).mode & 0o777).toBe(0o600);
    expect(receipt.contentSha256).toBe(hash);
    await receipt.cleanup();
    await expect(stat(receipt.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a client hash that does not match the received bytes and cleans temp files', async () => {
    const store = new MediaObjectStore();
    await expect(store.receiveIncoming({
      stream: Readable.from(Buffer.from('actual')),
      attemptId: randomUUID(),
      leaseId: randomUUID(),
      byteSize: 6,
      contentSha256: '00'.repeat(32),
      remainingDeadlineMs: 5_000,
    })).rejects.toMatchObject({ code: 'MEDIA_HASH_MISMATCH', status: 422 });
    expect((await import('node:fs/promises').then(({ readdir }) => readdir(directory)))).toEqual([]);
  });

  it('enforces the same 20 MiB upper bound before accepting a stream', async () => {
    const store = new MediaObjectStore();
    await expect(store.receiveIncoming({
      stream: Readable.from(Buffer.alloc(0)),
      attemptId: randomUUID(),
      leaseId: randomUUID(),
      byteSize: MAX_MEDIA_UPLOAD_BYTES + 1,
      contentSha256: '00'.repeat(32),
      remainingDeadlineMs: 5_000,
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_INVALID', status: 413 });
  });
});
