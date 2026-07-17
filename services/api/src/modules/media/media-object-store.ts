import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectAttributesCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';

export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface IncomingMediaReceipt {
  readonly path: string;
  readonly manifestPath: string;
  readonly byteSize: number;
  readonly contentSha256: string;
  cleanup(): Promise<void>;
}

export interface ProviderObjectReceipt {
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly contentSha256: string;
}

interface MediaObjectBinding {
  objectKey: string;
  objectVersion: string;
  contentSha256: string;
  byteSize: number;
  mimeType: string;
}

interface ObjectStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  tempDirectory: string;
  outboundDeadlineMs: number;
}

@Injectable()
export class MediaObjectStore {
  private clientValue?: S3Client;
  private configValue?: ObjectStoreConfig;

  async receiveIncoming(input: {
    stream: Readable;
    attemptId: string;
    leaseId: string;
    byteSize: number;
    contentSha256: string;
    remainingDeadlineMs: number;
  }): Promise<IncomingMediaReceipt> {
    if (input.byteSize < 1 || input.byteSize > MAX_MEDIA_UPLOAD_BYTES) {
      throw new DomainError('MEDIA_SIZE_INVALID', '图片大小必须在 20MB 以内。', 413);
    }
    if (input.remainingDeadlineMs <= 0) {
      throw new DomainError('MEDIA_GATEWAY_DEADLINE_EXCEEDED', '图片上传已超时。', 408, {
        retryable: true,
      });
    }
    const directory = await this.secureTempDirectory();
    const basename = `${input.attemptId}-${input.leaseId}-${randomUUID()}`;
    const path = this.confinedPath(directory, `${basename}.upload`);
    const manifestPath = this.confinedPath(directory, `${basename}.json`);
    await writeFile(manifestPath, JSON.stringify({
      attemptId: input.attemptId,
      leaseId: input.leaseId,
      byteSize: input.byteSize,
      createdAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });

    const digest = createHash('sha256');
    let bytesReceived = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesReceived += chunk.byteLength;
        if (bytesReceived > input.byteSize || bytesReceived > MAX_MEDIA_UPLOAD_BYTES) {
          callback(new DomainError('MEDIA_SIZE_MISMATCH', '图片实际大小与上传声明不一致。', 422));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), input.remainingDeadlineMs);
    try {
      await pipeline(
        input.stream,
        meter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: abort.signal },
      );
      if (bytesReceived !== input.byteSize) {
        throw new DomainError('MEDIA_SIZE_MISMATCH', '图片实际大小与上传声明不一致。', 422);
      }
      const actualHash = digest.digest('hex');
      if (actualHash !== input.contentSha256) {
        throw new DomainError('MEDIA_HASH_MISMATCH', '图片内容校验失败。', 422);
      }
      return {
        path,
        manifestPath,
        byteSize: bytesReceived,
        contentSha256: actualHash,
        cleanup: () => this.removeIncoming(path, manifestPath),
      };
    } catch (error) {
      await this.removeIncoming(path, manifestPath);
      if (abort.signal.aborted) {
        throw new DomainError('MEDIA_GATEWAY_DEADLINE_EXCEEDED', '图片上传已超时。', 408, {
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async putVerifiedObject(input: {
    receipt: IncomingMediaReceipt;
    objectKey: string;
    mimeType: string;
  }): Promise<ProviderObjectReceipt> {
    const config = this.config();
    const checksum = Buffer.from(input.receipt.contentSha256, 'hex').toString('base64');
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.outboundDeadlineMs);
    try {
      const response = await this.client().send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.objectKey,
        Body: createReadStream(input.receipt.path),
        ContentLength: input.receipt.byteSize,
        ContentType: input.mimeType,
        ChecksumSHA256: checksum,
        Metadata: { 'spott-sha256': input.receipt.contentSha256 },
        CacheControl: 'private, no-store',
        ServerSideEncryption: 'AES256',
      }), { abortSignal: abort.signal });
      if (!response.VersionId || response.ChecksumSHA256 !== checksum) {
        throw new DomainError(
          'MEDIA_PROVIDER_RECEIPT_UNVERIFIABLE',
          '对象存储未返回可验证的版本与校验和。',
          503,
          { retryable: true },
        );
      }
      return {
        objectKey: input.objectKey,
        objectVersion: response.VersionId,
        contentSha256: input.receipt.contentSha256,
      };
    } catch (error) {
      if (abort.signal.aborted) {
        throw new DomainError('MEDIA_PROVIDER_DEADLINE_EXCEEDED', '对象存储写入超时。', 503, {
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async assertVerifiedObject(input: MediaObjectBinding): Promise<void> {
    const config = this.config();
    const expectedChecksum = Buffer.from(input.contentSha256, 'hex').toString('base64');
    const head = await this.client().send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      VersionId: input.objectVersion,
      ChecksumMode: 'ENABLED',
    }));
    if (
      head.VersionId !== input.objectVersion
      || head.ContentLength !== input.byteSize
      || head.ContentType !== input.mimeType
      || head.ChecksumSHA256 !== expectedChecksum
      || head.Metadata?.['spott-sha256'] !== input.contentSha256
    ) {
      throw new DomainError('MEDIA_PROVIDER_RECEIPT_MISMATCH', '对象存储内容验证失败。', 409, {
        retryable: true,
      });
    }
    const attributes = await this.client().send(new GetObjectAttributesCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      VersionId: input.objectVersion,
      ObjectAttributes: ['Checksum', 'ObjectSize'],
    }));
    if (
      attributes.VersionId !== input.objectVersion
      || attributes.ObjectSize !== input.byteSize
      || attributes.Checksum?.ChecksumSHA256 !== expectedChecksum
    ) {
      throw new DomainError('MEDIA_PROVIDER_RECEIPT_MISMATCH', '对象存储版本验证失败。', 409, {
        retryable: true,
      });
    }
  }

  async deleteExactObject(objectKey: string, objectVersion: string): Promise<void> {
    const config = this.config();
    await this.client().send(new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      VersionId: objectVersion,
    }));
  }

  private client(): S3Client {
    if (this.clientValue) return this.clientValue;
    const config = this.config();
    this.clientValue = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.accessKeyId && config.secretAccessKey
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
    });
    return this.clientValue;
  }

  private config(): ObjectStoreConfig {
    if (this.configValue) return this.configValue;
    if (process.env.MEDIA_OBJECT_STORE_PROVIDER !== 's3') {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体对象存储尚未配置。', 503, {
        retryable: true,
      });
    }
    const bucket = process.env.MEDIA_S3_BUCKET;
    const region = process.env.MEDIA_S3_REGION ?? process.env.AWS_REGION;
    const tempDirectory = process.env.MEDIA_GATEWAY_TEMP_DIRECTORY;
    const accessKeyId = process.env.MEDIA_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.MEDIA_S3_SECRET_ACCESS_KEY;
    if (!bucket || !region || !tempDirectory || !isAbsolute(tempDirectory)) {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体对象存储配置不完整。', 503, {
        retryable: false,
      });
    }
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体对象存储凭证配置不完整。', 503, {
        retryable: false,
      });
    }
    const outboundDeadlineMs = this.positiveInteger(
      process.env.MEDIA_PROVIDER_DEADLINE_MS,
      30_000,
      1_000,
      120_000,
    );
    const config: ObjectStoreConfig = {
      bucket,
      region,
      tempDirectory,
      forcePathStyle: process.env.MEDIA_S3_FORCE_PATH_STYLE === 'true',
      outboundDeadlineMs,
      ...(process.env.MEDIA_S3_ENDPOINT ? { endpoint: process.env.MEDIA_S3_ENDPOINT } : {}),
      ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
    };
    this.configValue = config;
    return config;
  }

  private async secureTempDirectory(): Promise<string> {
    const directory = resolve(this.config().tempDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体临时目录不安全。', 503);
    }
    return directory;
  }

  private confinedPath(directory: string, basename: string): string {
    const candidate = resolve(join(directory, basename));
    if (!candidate.startsWith(`${resolve(directory)}${sep}`)) {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体临时路径无效。', 503);
    }
    return candidate;
  }

  private async removeIncoming(path: string, manifestPath: string): Promise<void> {
    await Promise.all([
      rm(path, { force: true }),
      rm(manifestPath, { force: true }),
    ]);
  }

  private positiveInteger(
    raw: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体上传时限配置无效。', 503);
    }
    return value;
  }
}
