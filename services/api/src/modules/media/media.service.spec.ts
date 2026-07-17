import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaCapabilityCodec } from './media-capability.js';
import type { IncomingMediaReceipt, MediaObjectStore } from './media-object-store.js';
import { MediaService } from './media.service.js';

const user = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['user'],
};
const attemptId = '019b0000-0000-7000-8000-000000000010';
const assetId = '019b0000-0000-7000-9000-000000000001';
const completionKey = '019b0000-0000-7000-8000-000000000011';
const hash = 'ab'.repeat(32);

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: assetId,
    current_owner_id: user.id,
    purpose: 'event_cover',
    original_filename: 'cover.jpg',
    mime_type: 'image/jpeg',
    byte_size: '16',
    focal_x: 0.5,
    focal_y: 0.5,
    state: 'pending_upload',
    moderation_state: 'pending',
    upload_attempt_id: attemptId,
    intent_request_hash: Buffer.alloc(32, 1),
    expected_content_hash: Buffer.from(hash, 'hex'),
    content_hash: null,
    capability_generation: '0',
    row_version: '0',
    renewal_disabled_at: null,
    legacy_object_reconciliation_required: false,
    legacy_preallocated_object_key: null,
    authoritative_object_key: null,
    authoritative_object_version: null,
    authoritative_object_checksum: null,
    latest_authorization_expires_at: null,
    cleanup_not_before: null,
    created_at: new Date('2026-07-17T00:00:00Z'),
    ...overrides,
  };
}

function transactionDatabase(client: { query: ReturnType<typeof vi.fn> }) {
  return {
    transaction: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
  };
}

beforeEach(() => {
  vi.stubEnv('MEDIA_GATEWAY_CAPABILITY_KEY_BASE64URL', Buffer.alloc(32, 7).toString('base64url'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MediaService Task 22 executable boundary', () => {
  it('implements every method invoked by MediaController', () => {
    const service = new MediaService({} as never) as unknown as Record<string, unknown>;

    for (const method of [
      'createIntent',
      'recoverAttempt',
      'uploadContent',
      'complete',
      'abandon',
      'attachEvent',
      'attachProfile',
      'attachGroup',
      'arrangeEvent',
    ]) expect(service[method], method).toBeTypeOf('function');
  });

  it('contains no browser-facing loopback/provider upload fallback', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('./media.service.ts', import.meta.url),
      'utf8',
    ));

    expect(source).not.toMatch(/MEDIA_UPLOAD_ORIGIN/u);
    expect(source).not.toMatch(/127\.0\.0\.1/u);
    expect(source).toContain('/v1/media/upload-attempts/');
  });

  it('creates an owner-scoped attempt and persists only a capability-free replay stub', async () => {
    const row = asset();
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        void values;
        if (sql.includes('FROM sync.idempotency_keys')) return { rows: [], rowCount: 0 };
        if (sql.includes('WHERE current_owner_id = $1 AND upload_attempt_id = $2')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO media.assets')) return { rows: [row], rowCount: 1 };
        if (sql.includes('FROM media.gateway_upload_leases')) return { rows: [], rowCount: 0 };
        if (sql.includes('clock_timestamp() AS now')) {
          return { rows: [{ now: new Date('2026-07-17T00:00:00Z') }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new MediaService(transactionDatabase(client) as never);

    const result = await service.createIntent(user, {
      purpose: 'event_cover',
      filename: 'cover.jpg',
      mimeType: 'image/jpeg',
      byteSize: 16,
      focalX: 0.5,
      focalY: 0.5,
      contentSha256: hash,
    }, attemptId);

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      attemptId,
      assetId,
      uploadUrl: `/v1/media/upload-attempts/${attemptId}/content`,
      method: 'PUT',
      maxBytes: 16,
    });
    expect(String((result.body as { uploadUrl: string }).uploadUrl)).not.toMatch(/^https?:\/\//u);
    const replayCall = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO sync.idempotency_keys'));
    expect(replayCall?.[1]?.[4]).toEqual({
      resourceType: 'media.upload_intent',
      resourceId: assetId,
      state: 'pending_upload',
    });
    expect(JSON.stringify(replayCall?.[1]?.[4])).not.toMatch(/capability|uploadUrl|objectKey/iu);
  });

  it('claims once, streams through the object boundary, and commits an exact provider receipt', async () => {
    const original = asset();
    const committedLease = {
      asset_id: assetId,
      capability_generation: '0',
      lease_id: '019b0000-0000-7000-8000-000000000099',
      state: 'committed',
      staging_object_key: `private/gateway/${assetId}/0/lease`,
      provider_object_version: 'version-1',
      provider_object_checksum: Buffer.from(hash, 'hex'),
      committed_at: new Date('2026-07-17T00:00:01Z'),
    };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT * FROM media.assets') && sql.includes('current_owner_id')) {
          return { rows: [original], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM media.gateway_upload_leases')) return { rows: [], rowCount: 0 };
        if (sql.includes("SET state = 'provider_writing'")) return { rows: [], rowCount: 1 };
        if (sql.includes("SET state = 'committed'")) {
          return { rows: [{ ...committedLease, lease_id: values?.[2] }], rowCount: 1 };
        }
        if (sql.includes('SET authoritative_object_key')) {
          return {
            rows: [asset({
              authoritative_object_key: values?.[3],
              authoritative_object_version: values?.[4],
              authoritative_object_checksum: Buffer.from(hash, 'hex'),
              row_version: '1',
            })],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const incoming: IncomingMediaReceipt = {
      path: '/secure/tmp/input',
      manifestPath: '/secure/tmp/input.json',
      byteSize: 16,
      contentSha256: hash,
      cleanup,
    };
    const receiveIncoming = vi.fn().mockResolvedValue(incoming);
    const putVerifiedObject = vi.fn().mockImplementation(async (input: { objectKey: string }) => ({
      objectKey: input.objectKey,
      objectVersion: 'version-1',
      contentSha256: hash,
    }));
    const deleteExactObject = vi.fn();
    const objects = {
      receiveIncoming,
      putVerifiedObject,
      deleteExactObject,
    } as unknown as MediaObjectStore;
    const capability = new MediaCapabilityCodec().issue({
      method: 'PUT',
      routePath: `/v1/media/upload-attempts/${attemptId}/content`,
      attemptId,
      assetId,
      ownerId: user.id,
      generation: 0,
      mimeType: 'image/jpeg',
      byteSize: 16,
      contentSha256: hash,
      expiresAt: Date.now() + 60_000,
    });
    const service = new MediaService(transactionDatabase(client) as never, objects);

    await expect(service.uploadContent({
      attemptId,
      capability,
      mimeType: 'image/jpeg',
      byteSize: 16,
      contentSha256: hash,
      handlerStartedAt: performance.now(),
      stream: Readable.from(Buffer.alloc(16)),
    })).resolves.toMatchObject({ assetId, state: 'committed', leaseState: 'committed' });

    expect(receiveIncoming).toHaveBeenCalledWith(expect.objectContaining({
      attemptId,
      byteSize: 16,
      contentSha256: hash,
    }));
    expect(putVerifiedObject).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    const authoritativeUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes('SET authoritative_object_key'));
    expect(authoritativeUpdate?.[1]?.[5]).toBe(hash);
  });

  it('verifies the exact provider version before trusting the expected hash and enqueues once', async () => {
    const trusted = asset({
      authoritative_object_key: `private/gateway/${assetId}/0/lease`,
      authoritative_object_version: 'version-1',
      authoritative_object_checksum: Buffer.from(hash, 'hex'),
    });
    const committedLease = {
      asset_id: assetId,
      capability_generation: '0',
      lease_id: '019b0000-0000-7000-8000-000000000099',
      state: 'committed',
      staging_object_key: trusted.authoritative_object_key,
      provider_object_version: 'version-1',
      provider_object_checksum: Buffer.from(hash, 'hex'),
      committed_at: new Date('2026-07-17T00:00:01Z'),
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM media.assets')) return { rows: [trusted], rowCount: 1 };
        if (sql.includes('FROM media.completion_receipts')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM media.gateway_upload_leases')) return { rows: [committedLease], rowCount: 1 };
        if (sql.includes('UPDATE media.assets')) {
          return { rows: [{ id: assetId, state: 'uploaded', moderation_state: 'pending' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO sync.outbox_events')) {
          return { rows: [{ event_id: '019b0000-0000-7000-8000-000000000077' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const assertVerifiedObject = vi.fn().mockResolvedValue(undefined);
    const objects = { assertVerifiedObject } as unknown as MediaObjectStore;
    const service = new MediaService(transactionDatabase(client) as never, objects);

    await expect(service.complete(user, assetId, hash, completionKey)).resolves.toEqual({
      assetId,
      state: 'uploaded',
      moderationState: 'pending',
    });
    expect(assertVerifiedObject).toHaveBeenCalledWith({
      objectKey: trusted.authoritative_object_key,
      objectVersion: 'version-1',
      contentSha256: hash,
      byteSize: 16,
      mimeType: 'image/jpeg',
    });
    const verificationOrder = assertVerifiedObject.mock.invocationCallOrder[0]!;
    const assetUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE media.assets'));
    expect(assetUpdate).toBeDefined();
    expect(client.query.mock.invocationCallOrder[client.query.mock.calls.indexOf(assetUpdate!)]).toBeGreaterThan(verificationOrder);
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO sync.outbox_events'))).toHaveLength(1);
  });
});

describe('MediaService attachment authorization', () => {
  it('returns a retryable conflict while an authorized avatar is still processing', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM media.mutation_receipts')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM identity.profiles profile')) {
          return { rows: [{
            previous_asset_id: null,
            current_owner_id: user.id,
            purpose: 'profile_avatar',
            state: 'processing',
            moderation_state: 'pending',
            url: null,
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new MediaService(transactionDatabase(client) as never);

    await expect(service.attachProfile(user, assetId, completionKey)).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
      status: 409,
      retryable: true,
    });
  });

  it('requires the current group owner and an owned group cover', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM media.mutation_receipts')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new MediaService(transactionDatabase(client) as never);

    await expect(service.attachGroup(
      user,
      assetId,
      '019b0000-0000-7000-8300-000000000001',
      completionKey,
    )).rejects.toMatchObject({ code: 'MEDIA_ATTACH_FORBIDDEN', status: 403 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('group_record.owner_id'))).toBe(true);
  });
});
