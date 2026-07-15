import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp, { type Metadata } from 'sharp';
import type { WorkerConfig } from './config.js';
import type { WorkerDatabase } from './database.js';

interface MediaAssetRow {
  id: string;
  purpose: string;
  object_key: string;
  mime_type: string;
  byte_size: string;
  content_hash: Buffer | null;
  focal_x: number;
  focal_y: number;
  processing_attempts: number;
}

interface PosterJobRow {
  id: string;
  user_id: string;
  resource_type: string;
  resource_id: string;
  locale: string;
  template: string;
}

class MediaFailure extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly scanState = 'failed') {
    super(code);
    this.name = 'MediaFailure';
  }
}

const derivativeSpecs = {
  thumb: { width: 320, height: 240, quality: 80 },
  card: { width: 960, height: 640, quality: 84 },
  hero: { width: 1600, height: 900, quality: 86 },
} as const;

export class MediaProcessor {
  private readonly s3?: S3Client;

  constructor(private readonly database: WorkerDatabase, private readonly config: WorkerConfig) {
    if (config.OBJECT_STORE_PROVIDER === 's3') {
      this.s3 = new S3Client({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
      });
    }
  }

  async processAssets(limit: number): Promise<{ processed: number; ready: number; rejected: number }> {
    let processed = 0;
    let ready = 0;
    let rejected = 0;
    while (processed < limit) {
      const asset = await this.claimAsset();
      if (!asset) break;
      processed += 1;
      try {
        await this.processAsset(asset);
        ready += 1;
      } catch (error) {
        const failure = error instanceof MediaFailure
          ? error
          : new MediaFailure(error instanceof Error ? error.name.toUpperCase() : 'MEDIA_PROCESSING_FAILED', true);
        const attempts = asset.processing_attempts + 1;
        if (failure.retryable && attempts < 5) {
          const delay = Math.min(300, 2 ** attempts * 5);
          await this.database.query(
            `UPDATE media.assets SET state = 'uploaded', processing_locked_at = NULL,
               processing_locked_by = NULL, processing_available_at = clock_timestamp() + make_interval(secs => $2),
               failure_code = $3, scan_state = $4, updated_at = clock_timestamp() WHERE id = $1`,
            [asset.id, delay, failure.code, failure.scanState],
          );
        } else {
          rejected += 1;
          await this.database.query(
            `UPDATE media.assets SET state = 'rejected', processing_locked_at = NULL,
               processing_locked_by = NULL, failure_code = $2, scan_state = $3,
               scan_details = jsonb_build_object('code',$2::text), updated_at = clock_timestamp() WHERE id = $1`,
            [asset.id, failure.code, failure.scanState],
          );
        }
      }
    }
    return { processed, ready, rejected };
  }

  async renderPosters(limit: number): Promise<{ processed: number; ready: number; failed: number }> {
    let processed = 0;
    let ready = 0;
    let failed = 0;
    while (processed < limit) {
      const job = await this.claimPoster();
      if (!job) break;
      processed += 1;
      try {
        await this.renderPoster(job);
        ready += 1;
      } catch (error) {
        failed += 1;
        const code = error instanceof MediaFailure ? error.code : error instanceof Error ? error.name : 'POSTER_RENDER_FAILED';
        await this.database.query(
          `UPDATE growth.poster_jobs SET state = 'failed', failure_code = $2, updated_at = clock_timestamp()
           WHERE id = $1`,
          [job.id, String(code).slice(0, 120)],
        );
      }
    }
    return { processed, ready, failed };
  }

  private async claimAsset(): Promise<MediaAssetRow | null> {
    return this.database.transaction(async (client) => {
      const result = await client.query<MediaAssetRow>(
        `SELECT id, purpose, object_key, mime_type, byte_size::text, content_hash, focal_x, focal_y,
           processing_attempts
         FROM media.assets
         WHERE state IN ('uploaded','processing') AND processing_available_at <= clock_timestamp()
           AND (processing_locked_at IS NULL OR processing_locked_at < clock_timestamp() - interval '5 minutes')
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE media.assets SET state = 'processing', scan_state = 'scanning',
           processing_attempts = processing_attempts + 1, processing_locked_at = clock_timestamp(),
           processing_locked_by = $2, failure_code = NULL, updated_at = clock_timestamp() WHERE id = $1`,
        [row.id, this.config.WORKER_ID],
      );
      return row;
    });
  }

  private async processAsset(asset: MediaAssetRow): Promise<void> {
    const object = await this.readObject(asset.object_key);
    if (object.byteLength !== Number(asset.byte_size)) throw new MediaFailure('MEDIA_SIZE_MISMATCH', false);
    const digest = createHash('sha256').update(object).digest();
    if (asset.content_hash && !digest.equals(asset.content_hash)) throw new MediaFailure('MEDIA_HASH_MISMATCH', false);

    const scan = await this.scan(object);
    if (scan !== 'clean' && scan !== 'skipped') throw new MediaFailure('MALWARE_DETECTED', false, 'infected');

    let metadata: Metadata;
    try {
      metadata = await sharp(object, { limitInputPixels: this.config.MEDIA_MAX_PIXELS }).metadata();
    } catch {
      throw new MediaFailure('IMAGE_DECODE_FAILED', false);
    }
    if (!metadata.width || !metadata.height) throw new MediaFailure('IMAGE_DIMENSIONS_MISSING', false);
    if (metadata.width * metadata.height > this.config.MEDIA_MAX_PIXELS) throw new MediaFailure('IMAGE_PIXEL_LIMIT_EXCEEDED', false);
    if ((metadata.pages ?? 1) > 1) throw new MediaFailure('ANIMATED_IMAGE_NOT_ALLOWED', false);
    const detectedMime = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heic' } as Record<string, string>)[metadata.format ?? ''];
    if (!detectedMime || detectedMime !== asset.mime_type) throw new MediaFailure('MEDIA_TYPE_MISMATCH', false);

    const publicAsset = asset.purpose !== 'report_evidence';
    const derivatives: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(derivativeSpecs)) {
      const buffer = await sharp(object, { limitInputPixels: this.config.MEDIA_MAX_PIXELS })
        .rotate()
        .resize({ width: spec.width, height: spec.height, fit: 'cover', position: 'attention' })
        .webp({ quality: spec.quality, effort: 4 })
        .toBuffer();
      const key = `${publicAsset ? 'public' : 'restricted'}/derivatives/${asset.id}/${name}.webp`;
      await this.putObject(key, buffer, 'image/webp', publicAsset ? 'public, max-age=31536000, immutable' : 'private, no-store');
      derivatives[name] = {
        objectKey: key,
        ...(publicAsset ? { url: this.publicUrl(key) } : {}),
        width: spec.width,
        height: spec.height,
        byteSize: buffer.byteLength,
        mimeType: 'image/webp',
      };
    }
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE media.assets SET state = 'ready', derivatives = $2, scan_state = $3,
           scan_details = $4, ready_at = clock_timestamp(), failure_code = NULL,
           processing_locked_at = NULL, processing_locked_by = NULL, updated_at = clock_timestamp()
         WHERE id = $1`,
        [asset.id, derivatives, scan, { engine: this.config.MEDIA_SCAN_PROVIDER, digest: digest.toString('hex') }],
      );
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('media.asset',$1,'media.ready',$2)`,
        [asset.id, { assetId: asset.id, derivatives: Object.keys(derivatives) }],
      );
    });
  }

  private async readObject(key: string): Promise<Buffer> {
    if (!this.s3) throw new MediaFailure('OBJECT_STORE_DISABLED', false);
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
      if (!response.Body) throw new MediaFailure('OBJECT_NOT_FOUND', true);
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof MediaFailure) throw error;
      throw new MediaFailure('OBJECT_STORE_READ_FAILED', true);
    }
  }

  private async putObject(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> {
    if (!this.s3) throw new MediaFailure('OBJECT_STORE_DISABLED', false);
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
        CacheControl: cacheControl,
      }));
    } catch {
      throw new MediaFailure('OBJECT_STORE_WRITE_FAILED', true);
    }
  }

  private scan(buffer: Buffer): Promise<'clean' | 'skipped'> {
    if (this.config.MEDIA_SCAN_PROVIDER === 'disabled') return Promise.resolve('skipped');
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.config.CLAMAV_HOST, port: this.config.CLAMAV_PORT });
      let response = '';
      let settled = false;
      const finish = (error?: MediaFailure): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else if (/\bFOUND\b/.test(response)) reject(new MediaFailure('MALWARE_DETECTED', false, 'infected'));
        else if (/\bOK\b/.test(response)) resolve('clean');
        else reject(new MediaFailure('MALWARE_SCANNER_INVALID_RESPONSE', true));
      };
      socket.setTimeout(this.config.CLAMAV_TIMEOUT_MS, () => finish(new MediaFailure('MALWARE_SCANNER_TIMEOUT', true)));
      socket.once('error', () => finish(new MediaFailure('MALWARE_SCANNER_UNAVAILABLE', true)));
      socket.on('data', (chunk: Buffer) => { response += chunk.toString('utf8'); });
      socket.once('end', () => finish());
      socket.once('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
          const chunk = buffer.subarray(offset, Math.min(offset + 64 * 1024, buffer.length));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }

  private async claimPoster(): Promise<PosterJobRow | null> {
    return this.database.transaction(async (client) => {
      const result = await client.query<PosterJobRow>(
        `SELECT id, user_id, resource_type, resource_id, locale, template FROM growth.poster_jobs
         WHERE state = 'queued' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query("UPDATE growth.poster_jobs SET state = 'processing', updated_at = clock_timestamp() WHERE id = $1", [row.id]);
      return row;
    });
  }

  private async renderPoster(job: PosterJobRow): Promise<void> {
    const resource = await this.database.query<{ title: string }>(
      `SELECT title FROM events.events WHERE $1 = 'event' AND id = $2
       UNION ALL SELECT name AS title FROM community.groups WHERE $1 = 'group' AND id = $2
       UNION ALL SELECT nickname AS title FROM identity.profiles WHERE $1 = 'profile' AND user_id = $2
       LIMIT 1`,
      [job.resource_type, job.resource_id],
    );
    const title = resource.rows[0]?.title;
    if (!title) throw new MediaFailure('POSTER_RESOURCE_NOT_FOUND', false);
    const safeTitle = escapeXml(title.slice(0, 80));
    const label = job.locale === 'ja' ? '新しい出会いを、街の中で。' : job.locale === 'en' ? 'Find your people, in your city.' : '在城市里，遇见同频的人。';
    const svg = Buffer.from(`<svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#5F4BFF"/><stop offset="1" stop-color="#FF6B64"/></linearGradient></defs>
      <rect width="1080" height="1350" rx="0" fill="#F7F5F0"/><circle cx="880" cy="180" r="360" fill="url(#g)" opacity=".92"/>
      <text x="80" y="112" font-family="Arial, sans-serif" font-size="38" font-weight="700" letter-spacing="8" fill="#17171B">SPOTT</text>
      <text x="80" y="650" font-family="Arial, sans-serif" font-size="78" font-weight="700" fill="#17171B">${safeTitle}</text>
      <text x="80" y="760" font-family="Arial, sans-serif" font-size="36" fill="#5C5C66">${escapeXml(label)}</text>
      <rect x="80" y="1120" width="920" height="2" fill="#17171B" opacity=".18"/><text x="80" y="1215" font-family="Arial, sans-serif" font-size="30" fill="#5C5C66">spott.jp</text>
    </svg>`);
    const output = await sharp(svg).webp({ quality: 90, effort: 5 }).toBuffer();
    const key = `public/posters/${job.id}.webp`;
    await this.putObject(key, output, 'image/webp', 'public, max-age=31536000, immutable');
    const hash = createHash('sha256').update(output).digest();
    await this.database.transaction(async (client) => {
      const asset = await client.query<{ id: string }>(
        `INSERT INTO media.assets(owner_id,purpose,object_key,original_filename,mime_type,byte_size,content_hash,
           state,moderation_state,derivatives,uploaded_at,ready_at,scan_state,scan_details)
         VALUES ($1,'share_poster',$2,$3,'image/webp',$4,$5,'ready','approved',$6,
           clock_timestamp(),clock_timestamp(),'skipped','{"source":"generated"}') RETURNING id`,
        [job.user_id, key, `spott-${job.resource_type}.webp`, output.byteLength, hash, {
          poster: { objectKey: key, url: this.publicUrl(key), width: 1080, height: 1350, byteSize: output.byteLength, mimeType: 'image/webp' },
        }],
      );
      await client.query(
        `UPDATE growth.poster_jobs SET state = 'ready', asset_id = $2, failure_code = NULL,
           updated_at = clock_timestamp() WHERE id = $1`,
        [job.id, asset.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO notification.notifications(
           user_id,type,template_version,payload_ref,resource_type,resource_public_id,dedupe_key
         ) VALUES ($1,$2,COALESCE((SELECT max(version) FROM notification.templates
             WHERE type=$2 AND active),1),$4,'event',$3,$5)
         ON CONFLICT (user_id,type,dedupe_key) DO NOTHING`,
        [job.user_id, 'poster.ready', job.resource_id, {
          posterJobId: job.id,
          eventId: job.resource_id,
          resourceType: job.resource_type,
          resourceId: job.resource_id,
          url: this.publicUrl(key),
          title,
        }, `poster.ready:${job.id}`],
      );
    });
  }

  private publicUrl(key: string): string {
    return `${this.config.MEDIA_PUBLIC_ORIGIN.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}
