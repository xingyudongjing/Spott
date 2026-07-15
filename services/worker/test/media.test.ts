import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { MediaProcessor } from '../src/media.js';

describe('media processing pipeline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifies an uploaded image and writes three immutable WebP derivatives', async () => {
    const input = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#6655ff' },
    }).png().toBuffer();
    const writes: PutObjectCommand[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array(input) } } as never;
      }
      if (command instanceof PutObjectCommand) {
        writes.push(command);
        return {} as never;
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    });

    let claimed = false;
    let derivatives: Record<string, { url: string; mimeType: string }> | undefined;
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (text.includes('FROM media.assets')) {
          if (claimed) return { rows: [], rowCount: 0 };
          claimed = true;
          return { rows: [{
            id: '10000000-0000-0000-0000-000000000001',
            purpose: 'event_cover',
            object_key: 'original/user/photo.png',
            mime_type: 'image/png',
            byte_size: String(input.byteLength),
            content_hash: createHash('sha256').update(input).digest(),
            focal_x: 0.5,
            focal_y: 0.5,
            processing_attempts: 0,
          }], rowCount: 1 };
        }
        if (text.includes("SET state = 'ready'")) {
          derivatives = values[1] as typeof derivatives;
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("SET state = 'processing'") || text.includes('INSERT INTO sync.outbox_events')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
      query: client.query,
    };
    const config = parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://spott:spott@localhost/spott',
      MEDIA_SCAN_PROVIDER: 'disabled',
      MEDIA_PUBLIC_ORIGIN: 'http://127.0.0.1:9100/spott-media',
    });

    const result = await new MediaProcessor(database as never, config).processAssets(1);

    expect(result).toEqual({ processed: 1, ready: 1, rejected: 0 });
    expect(writes).toHaveLength(3);
    expect(writes.map((write) => write.input.Key)).toEqual([
      'public/derivatives/10000000-0000-0000-0000-000000000001/thumb.webp',
      'public/derivatives/10000000-0000-0000-0000-000000000001/card.webp',
      'public/derivatives/10000000-0000-0000-0000-000000000001/hero.webp',
    ]);
    expect(derivatives?.card).toMatchObject({
      mimeType: 'image/webp',
      url: 'http://127.0.0.1:9100/spott-media/public/derivatives/10000000-0000-0000-0000-000000000001/card.webp',
    });
  });

  it('notifies the organizer after an approved-event poster becomes ready', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    let claimed = false;
    let notificationPayload: unknown;
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (text.includes('FROM growth.poster_jobs')) {
          if (claimed) return { rows: [], rowCount: 0 };
          claimed = true;
          return { rows: [{
            id: '10000000-0000-0000-0000-000000000010',
            user_id: '10000000-0000-0000-0000-000000000011',
            resource_type: 'event',
            resource_id: '10000000-0000-0000-0000-000000000012',
            locale: 'zh-Hans',
            template: 'event_approved',
          }], rowCount: 1 };
        }
        if (text.includes('SELECT title FROM events.events')) {
          return { rows: [{ title: '东京玻璃体验会' }], rowCount: 1 };
        }
        if (text.includes('INSERT INTO media.assets')) {
          return { rows: [{ id: '10000000-0000-0000-0000-000000000013' }], rowCount: 1 };
        }
        if (text.includes('INSERT INTO notification.notifications')) {
          notificationPayload = values[3];
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("SET state = 'processing'") || text.includes("SET state = 'ready'")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
      query: client.query,
    };
    const config = parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://spott:spott@localhost/spott',
      MEDIA_SCAN_PROVIDER: 'disabled',
      MEDIA_PUBLIC_ORIGIN: 'http://127.0.0.1:9100/spott-media',
    });

    await expect(new MediaProcessor(database as never, config).renderPosters(1)).resolves.toEqual({
      processed: 1,
      ready: 1,
      failed: 0,
    });
    expect(notificationPayload).toMatchObject({
      posterJobId: '10000000-0000-0000-0000-000000000010',
      eventId: '10000000-0000-0000-0000-000000000012',
    });
  });
});
