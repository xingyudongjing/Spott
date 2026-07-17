import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Readable } from 'node:stream';
import { Database } from '../../platform/database.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { MediaCapabilityCodec } from './media-capability.js';
import {
  MAX_MEDIA_UPLOAD_BYTES,
  MediaObjectStore,
  type ProviderObjectReceipt,
} from './media-object-store.js';

type ImagePurpose = 'event_cover' | 'profile_avatar' | 'group_cover' | 'report_evidence' | 'share_poster';
type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

interface IntentInput {
  purpose: ImagePurpose;
  filename: string;
  mimeType: ImageMime;
  byteSize: number;
  focalX: number;
  focalY: number;
  contentSha256: string;
}

interface AssetRow extends QueryResultRow {
  id: string;
  current_owner_id: string;
  purpose: ImagePurpose;
  original_filename: string;
  mime_type: ImageMime;
  byte_size: string;
  focal_x: number;
  focal_y: number;
  state: string;
  moderation_state: string;
  upload_attempt_id: string | null;
  intent_request_hash: Buffer | null;
  expected_content_hash: Buffer | null;
  content_hash: Buffer | null;
  capability_generation: string;
  row_version: string;
  renewal_disabled_at: Date | null;
  legacy_object_reconciliation_required: boolean;
  legacy_preallocated_object_key: string | null;
  authoritative_object_key: string | null;
  authoritative_object_version: string | null;
  authoritative_object_checksum: Buffer | null;
  latest_authorization_expires_at: Date | null;
  cleanup_not_before: Date | null;
  created_at: Date;
}

interface GatewayLeaseRow extends QueryResultRow {
  asset_id: string;
  capability_generation: string;
  lease_id: string;
  state: 'receiving' | 'provider_writing' | 'committed' | 'failed_cleanup_pending' | 'failed_clean';
  staging_object_key: string;
  provider_object_version: string | null;
  provider_object_checksum: Buffer | null;
  committed_at: Date | null;
}

interface MutationReceiptRow extends QueryResultRow {
  request_fingerprint: Buffer;
  replay_response: Record<string, unknown>;
}

interface CompletionReceiptRow extends QueryResultRow {
  verified_content_hash: Buffer | null;
  replay_response: Record<string, unknown> | null;
}

@Injectable()
export class MediaService {
  private readonly capability = new MediaCapabilityCodec();

  constructor(
    private readonly database: Database,
    private readonly objects: MediaObjectStore = new MediaObjectStore(),
  ) {}

  async createIntent(
    user: AuthenticatedUser,
    rawInput: IntentInput,
    key: string,
  ): Promise<{ status: 200 | 201; body: unknown }> {
    const input = this.normalizeIntent(rawInput);
    this.assertCreationAllowed(user, input.purpose);
    const fingerprint = this.fingerprint('POST', '/media/upload-intents', {
      currentOwnerId: user.id,
      ...input,
    });

    return this.database.transaction(async (client) => {
      const generic = await client.query<{
        request_hash: Buffer;
        resource_type: string | null;
      }>(
        `SELECT request_hash, resource_type
         FROM sync.idempotency_keys
         WHERE user_id = $1 AND key = $2 FOR UPDATE`,
        [user.id, key],
      );
      const genericRow = generic.rows[0];
      if (genericRow && (
        !genericRow.request_hash.equals(fingerprint)
        || genericRow.resource_type !== 'media.upload_intent'
      )) this.idempotencyConflict();

      let asset = await this.findAttempt(client, user.id, key, true);
      const created = !asset;
      if (asset && (!asset.intent_request_hash || !asset.intent_request_hash.equals(fingerprint))) {
        this.idempotencyConflict();
      }
      if (!asset) {
        const inserted = await client.query<AssetRow>(
          `INSERT INTO media.assets(
             current_owner_id, created_owner_id, purpose,
             legacy_preallocated_object_key, upload_attempt_id, intent_request_hash,
             expected_content_hash, original_filename, mime_type, byte_size, focal_x, focal_y
           ) VALUES ($1,$1,$2,NULL,$3,$4,decode($5,'hex'),$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            user.id,
            input.purpose,
            key,
            fingerprint,
            input.contentSha256,
            input.filename,
            input.mimeType,
            input.byteSize,
            input.focalX,
            input.focalY,
          ],
        );
        asset = inserted.rows[0];
      }
      if (!asset) throw new DomainError('MEDIA_INTENT_FAILED', '无法创建媒体上传任务。', 503);

      await client.query(
        `INSERT INTO sync.idempotency_keys(
           key, user_id, request_hash, response_code, response_body,
           resource_type, resource_id, expires_at
         ) VALUES (
           $1,$2,$3,$4,$5,'media.upload_intent',$6,clock_timestamp() + interval '48 hours'
         ) ON CONFLICT (user_id, key) DO UPDATE SET
           response_code = EXCLUDED.response_code,
           response_body = EXCLUDED.response_body,
           resource_type = EXCLUDED.resource_type,
           resource_id = EXCLUDED.resource_id,
           expires_at = GREATEST(sync.idempotency_keys.expires_at, EXCLUDED.expires_at)
         WHERE sync.idempotency_keys.request_hash = EXCLUDED.request_hash
           AND sync.idempotency_keys.resource_type = 'media.upload_intent'`,
        [key, user.id, fingerprint, created ? 201 : 200, {
          resourceType: 'media.upload_intent',
          resourceId: asset.id,
          state: asset.state,
        }, asset.id],
      );

      return {
        status: created ? 201 : 200,
        body: await this.recoveryResponse(client, user, asset),
      };
    });
  }

  async recoverAttempt(user: AuthenticatedUser, attemptId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const asset = await this.findAttempt(client, user.id, attemptId, true);
      if (!asset) this.assetNotFound();
      this.assertCreationAllowed(user, asset.purpose);
      return this.recoveryResponse(client, user, asset);
    });
  }

  async uploadContent(input: {
    attemptId: string;
    capability: string;
    mimeType: ImageMime;
    byteSize: number;
    contentSha256: string;
    handlerStartedAt: number;
    stream: Readable;
  }): Promise<unknown> {
    const authorization = this.capability.verify(input.capability);
    if (
      authorization.method !== 'PUT'
      || authorization.routePath !== `/v1/media/upload-attempts/${input.attemptId}/content`
      authorization.attemptId !== input.attemptId
      || authorization.mimeType !== input.mimeType
      || authorization.byteSize !== input.byteSize
      || authorization.contentSha256 !== input.contentSha256
    ) this.invalidCapability();

    const totalDeadlineMs = this.numberSetting('MEDIA_GATEWAY_INBOUND_DEADLINE_MS', 30_000, 1_000, 120_000);
    const elapsedBeforeClaim = Math.max(0, performance.now() - input.handlerStartedAt);
    const remainingBeforeClaim = totalDeadlineMs - elapsedBeforeClaim;
    if (remainingBeforeClaim <= 0) this.gatewayDeadline();

    const claim = await this.database.transaction(async (client) => {
      const asset = await this.findAsset(client, authorization.assetId, authorization.ownerId, true);
      if (!asset || !this.capabilityMatchesAsset(asset, authorization)) this.invalidCapability();
      const lease = await this.currentLease(client, asset.id, Number(asset.capability_generation), true);
      if (lease) {
        if (lease.state === 'committed') return { response: this.committedState(asset, lease) };
        if (lease.state === 'receiving' || lease.state === 'provider_writing') {
          return { response: this.inProgressState(asset, lease.state) };
        }
        throw new DomainError('MEDIA_GATEWAY_CAPABILITY_EXPIRED', '上传授权已终止，请恢复任务。', 403);
      }

      const elapsed = Math.max(0, performance.now() - input.handlerStartedAt);
      const remainingDeadlineMs = totalDeadlineMs - elapsed;
      if (remainingDeadlineMs <= 0) this.gatewayDeadline();
      const leaseId = randomUUID();
      const tempManifestId = randomUUID();
      const stagingObjectKey = `private/gateway/${asset.id}/${asset.capability_generation}/${leaseId}`;
      await client.query(
        `INSERT INTO media.gateway_upload_leases(
           asset_id, capability_generation, lease_id, starting_asset_row_version,
           inbound_deadline_at, state, staging_object_key, temp_manifest_id
         ) VALUES (
           $1,$2,$3,$4,
           clock_timestamp() + ($5::text || ' milliseconds')::interval,
           'receiving',$6,$7
         )`,
        [
          asset.id,
          asset.capability_generation,
          leaseId,
          asset.row_version,
          Math.floor(remainingDeadlineMs),
          stagingObjectKey,
          tempManifestId,
        ],
      );
      return {
        asset,
        leaseId,
        stagingObjectKey,
        remainingDeadlineMs,
      };
    });
    if ('response' in claim) return claim.response;

    let providerReceipt: ProviderObjectReceipt | undefined;
    let phase: 'receiving' | 'provider_writing' = 'receiving';
    try {
      const incoming = await this.objects.receiveIncoming({
        stream: input.stream,
        attemptId: input.attemptId,
        leaseId: claim.leaseId,
        byteSize: input.byteSize,
        contentSha256: input.contentSha256,
        remainingDeadlineMs: claim.remainingDeadlineMs,
      });
      try {
        const providerDeadlineMs = this.numberSetting('MEDIA_PROVIDER_DEADLINE_MS', 30_000, 1_000, 120_000);
        await this.database.transaction(async (client) => {
          const advanced = await client.query(
            `UPDATE media.gateway_upload_leases
             SET state = 'provider_writing',
                 provider_deadline_at = clock_timestamp()
                   + ($4::text || ' milliseconds')::interval,
                 updated_at = clock_timestamp()
             WHERE asset_id = $1 AND capability_generation = $2 AND lease_id = $3
               AND state = 'receiving'`,
            [claim.asset.id, claim.asset.capability_generation, claim.leaseId, providerDeadlineMs],
          );
          if (advanced.rowCount !== 1) {
            throw new DomainError('MEDIA_GATEWAY_LEASE_LOST', '上传任务已由其他请求处理。', 409, {
              retryable: true,
            });
          }
        });
        phase = 'provider_writing';
        providerReceipt = await this.objects.putVerifiedObject({
          receipt: incoming,
          objectKey: claim.stagingObjectKey,
          mimeType: input.mimeType,
        });
        const response = await this.commitProviderReceipt(
          claim.asset,
          claim.leaseId,
          providerReceipt,
        );
        return response;
      } finally {
        await incoming.cleanup();
      }
    } catch (error) {
      let providerAbsenceConfirmed = false;
      if (providerReceipt) {
        try {
          await this.objects.deleteExactObject(
            providerReceipt.objectKey,
            providerReceipt.objectVersion,
          );
          providerAbsenceConfirmed = true;
        } catch {
          // The durable failed lease remains cleanup-pending and cannot be renewed.
        }
      }
      await this.markGatewayFailure(
        claim.asset,
        claim.leaseId,
        phase,
        providerReceipt,
        providerAbsenceConfirmed,
      );
      throw error;
    }
  }

  async complete(
    user: AuthenticatedUser,
    assetId: string,
    hash: string,
    completionKey: string,
  ): Promise<unknown> {
    const expectedHash = Buffer.from(hash, 'hex');
    const requestFingerprint = this.fingerprint('POST', `/media/${assetId}/complete`, {
      assetId,
      contentSha256: hash,
    });
    return this.database.transaction(async (client) => {
      const asset = await this.findAsset(client, assetId, user.id, true);
      if (!asset) this.assetNotFound();
      const existing = await client.query<CompletionReceiptRow>(
        `SELECT verified_content_hash, replay_response
         FROM media.completion_receipts WHERE asset_id = $1`,
        [assetId],
      );
      const receipt = existing.rows[0];
      if (receipt) {
        if (!receipt.verified_content_hash?.equals(expectedHash)) this.hashMismatch();
        if (receipt.replay_response) return receipt.replay_response;
      }
      if (!asset.expected_content_hash?.equals(expectedHash)) this.hashMismatch();
      if (
        asset.renewal_disabled_at
        || asset.legacy_object_reconciliation_required
        || !asset.upload_attempt_id
        || !asset.authoritative_object_key
        || !asset.authoritative_object_version
        || !asset.authoritative_object_checksum?.equals(expectedHash)
      ) {
        throw new DomainError('MEDIA_UPLOAD_NOT_COMMITTED', '图片尚未完成可信上传。', 409, {
          retryable: true,
        });
      }
      const lease = await this.currentLease(client, asset.id, Number(asset.capability_generation), true);
      if (
        !lease
        || lease.state !== 'committed'
        || lease.staging_object_key !== asset.authoritative_object_key
        || lease.provider_object_version !== asset.authoritative_object_version
        || !lease.provider_object_checksum?.equals(expectedHash)
      ) {
        throw new DomainError('MEDIA_UPLOAD_NOT_COMMITTED', '图片上传回执尚未确认。', 409, {
          retryable: true,
        });
      }
      await this.objects.assertVerifiedObject({
        objectKey: asset.authoritative_object_key,
        objectVersion: asset.authoritative_object_version,
        contentSha256: hash,
        byteSize: Number(asset.byte_size),
        mimeType: asset.mime_type,
      });
      const updated = await client.query<{
        id: string;
        state: string;
        moderation_state: string;
      }>(
        `UPDATE media.assets
         SET state = 'uploaded', content_hash = expected_content_hash,
             uploaded_at = COALESCE(uploaded_at, clock_timestamp()),
             row_version = row_version + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND current_owner_id = $2 AND state = 'pending_upload'
           AND content_hash IS NULL
         RETURNING id, state, moderation_state`,
        [assetId, user.id],
      );
      if (updated.rowCount !== 1) {
        throw new DomainError('MEDIA_STATE_CONFLICT', '图片状态已变化，请恢复任务。', 409, {
          retryable: true,
        });
      }
      const outbox = await client.query<{ event_id: string }>(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('media.asset', $1, 'media.processing_requested', $2)
         RETURNING event_id`,
        [assetId, { assetId }],
      );
      const response = {
        assetId,
        state: 'uploaded',
        moderationState: updated.rows[0]!.moderation_state,
      };
      await client.query(
        `INSERT INTO media.completion_receipts(
           asset_id, completion_attempt_id, request_fingerprint,
           verified_content_hash, replay_response, outbox_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [assetId, completionKey, requestFingerprint, expectedHash, response, outbox.rows[0]!.event_id],
      );
      return response;
    });
  }

  async abandon(user: AuthenticatedUser, assetId: string, key: string): Promise<unknown> {
    const canonical = { assetId };
    const fingerprint = this.fingerprint('DELETE', `/media/${assetId}`, canonical);
    return this.database.transaction(async (client) => {
      await this.lockMutationKey(client, user.id, 'asset_abandonment', key);
      const replay = await this.mutationReplay(client, user.id, 'asset_abandonment', key, fingerprint);
      if (replay !== null) return replay;
      const asset = await this.findAsset(client, assetId, user.id, true);
      if (!asset) this.assetNotFound();
      const references = await client.query<{ referenced: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM events.event_media WHERE media_asset_id = $1 OR asset_id = $1
           UNION ALL SELECT 1 FROM identity.profiles WHERE avatar_asset_id = $1 AND deleted_at IS NULL
           UNION ALL SELECT 1 FROM community.groups WHERE cover_asset_id = $1 AND deleted_at IS NULL
           UNION ALL SELECT 1 FROM safety.evidence_assets WHERE asset_id = $1 AND deleted_at IS NULL
           UNION ALL SELECT 1 FROM growth.poster_jobs WHERE asset_id = $1
         ) AS referenced`,
        [assetId],
      );
      if (references.rows[0]?.referenced) {
        throw new DomainError('MEDIA_ASSET_REFERENCED', '图片正在被使用，不能直接删除。', 409);
      }
      const activeLease = await client.query(
        `SELECT 1 FROM media.gateway_upload_leases
         WHERE asset_id = $1 AND state IN ('receiving','provider_writing')
         UNION ALL
         SELECT 1 FROM media.worker_processing_leases
         WHERE asset_id = $1 AND state = 'processing'
           AND lease_expires_at > clock_timestamp()
         LIMIT 1`,
        [assetId],
      );
      if (activeLease.rowCount) {
        throw new DomainError('MEDIA_ASSET_BUSY', '图片仍在处理中，请稍后重试。', 409, {
          retryable: true,
        });
      }
      const fence = await client.query<{ cleanup_not_before: Date }>(
        `SELECT GREATEST(clock_timestamp(), media.cleanup_fence_for_asset($1)) AS cleanup_not_before`,
        [assetId],
      );
      const cleanupNotBefore = fence.rows[0]!.cleanup_not_before;
      const state = asset.state === 'pending_upload' ? 'abandoned' : 'deleted';
      await client.query(
        `UPDATE media.assets
         SET state = $3, renewal_disabled_at = COALESCE(renewal_disabled_at, clock_timestamp()),
             abandoned_at = CASE WHEN $3 = 'abandoned' THEN COALESCE(abandoned_at, clock_timestamp()) ELSE abandoned_at END,
             deleted_at = CASE WHEN $3 = 'deleted' THEN COALESCE(deleted_at, clock_timestamp()) ELSE deleted_at END,
             tombstoned_at = COALESCE(tombstoned_at, clock_timestamp()),
             cleanup_not_before = GREATEST(COALESCE(cleanup_not_before, $4), $4),
             capability_generation = capability_generation + 1,
             processing_generation = processing_generation + 1,
             processing_lease_id = NULL, processing_lease_expires_at = NULL,
             row_version = row_version + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND current_owner_id = $2`,
        [assetId, user.id, state, cleanupNotBefore],
      );
      if (asset.authoritative_object_key && asset.authoritative_object_version) {
        await client.query(
          `INSERT INTO media.object_cleanup_tasks(
             asset_id, object_kind, object_key, object_version, cleanup_not_before
           ) VALUES ($1,'authoritative_original',$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [assetId, asset.authoritative_object_key, asset.authoritative_object_version, cleanupNotBefore],
        );
      } else if (asset.legacy_preallocated_object_key) {
        await client.query(
          `INSERT INTO media.object_cleanup_tasks(
             asset_id, object_kind, object_key, cleanup_not_before
           ) VALUES ($1,'legacy_preallocated',$2,$3)
           ON CONFLICT DO NOTHING`,
          [assetId, asset.legacy_preallocated_object_key, cleanupNotBefore],
        );
      }
      const response = {
        assetId,
        state,
        cleanupNotBefore: cleanupNotBefore.toISOString(),
      };
      await this.storeMutationReceipt(client, {
        userId: user.id,
        operation: 'asset_abandonment',
        key,
        fingerprint,
        canonical,
        response,
        resourceType: 'media.asset',
        resourceId: assetId,
      });
      return response;
    });
  }

  async attachEvent(
    user: AuthenticatedUser,
    assetId: string,
    eventId: string,
    input: { kind: string; sortOrder: number },
    key: string,
  ): Promise<unknown> {
    const sortOrder = input.kind === 'cover' ? 0 : Math.max(1, input.sortOrder);
    const canonical = { assetId, eventId, kind: input.kind, sortOrder };
    const fingerprint = this.fingerprint('POST', `/media/${assetId}/attach/event/${eventId}`, canonical);
    return this.database.transaction(async (client) => {
      await this.lockMutationKey(client, user.id, 'event_attachment', key);
      const replay = await this.mutationReplay(client, user.id, 'event_attachment', key, fingerprint);
      if (replay !== null) return replay;
      const authorized = await client.query<{
        event_id: string;
        current_owner_id: string;
        purpose: string;
        state: string;
        moderation_state: string;
        content_hash: Buffer | null;
      }>(
        `SELECT event.id AS event_id, asset.current_owner_id, asset.purpose,
           asset.state, asset.moderation_state, asset.content_hash
         FROM events.events event
         JOIN media.assets asset ON asset.id = $1
         WHERE event.id = $2 AND event.organizer_id = $3
           AND event.deleted_at IS NULL
         FOR UPDATE OF event, asset`,
        [assetId, eventId, user.id],
      );
      const asset = authorized.rows[0];
      if (
        !asset
        || asset.current_owner_id !== user.id
        || asset.purpose !== 'event_cover'
        || !asset.content_hash
        || !['uploaded', 'processing', 'ready'].includes(asset.state)
        || asset.moderation_state === 'rejected'
      ) throw new DomainError('MEDIA_ATTACH_FORBIDDEN', '无权将此图片用于该活动。', 403);
      if (sortOrder > 5) {
        throw new DomainError('EVENT_MEDIA_LIMIT_EXCEEDED', '活动最多上传 6 张图片。', 422);
      }
      const existingSlot = await client.query<{ asset_id: string }>(
        `SELECT asset_id FROM events.event_media
         WHERE event_id = $1 AND sort_order = $2 FOR UPDATE`,
        [eventId, sortOrder],
      );
      if (!existingSlot.rowCount) {
        const count = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM events.event_media WHERE event_id = $1',
          [eventId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= 6) {
          throw new DomainError('EVENT_MEDIA_LIMIT_EXCEEDED', '活动最多上传 6 张图片。', 422);
        }
      }
      const row = await client.query<{ id: string }>(
        `INSERT INTO events.event_media(
           event_id, asset_id, sort_order, focus_x, focus_y, content_hash, media_asset_id
         ) SELECT $1,id,$2,focal_x,focal_y,content_hash,id FROM media.assets WHERE id = $3
         ON CONFLICT (event_id, sort_order) DO UPDATE SET
           asset_id = EXCLUDED.asset_id, focus_x = EXCLUDED.focus_x, focus_y = EXCLUDED.focus_y,
           content_hash = EXCLUDED.content_hash, media_asset_id = EXCLUDED.media_asset_id
         RETURNING id`,
        [eventId, sortOrder, assetId],
      );
      const updatedEvent = await client.query<{ version: string }>(
        `UPDATE events.events SET updated_by = $2 WHERE id = $1 RETURNING version`,
        [eventId, user.id],
      );
      const mediaCount = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM events.event_media WHERE event_id = $1',
        [eventId],
      );
      const response = {
        id: row.rows[0]!.id,
        eventId,
        assetId,
        kind: input.kind,
        sortOrder,
        mediaCount: Number(mediaCount.rows[0]?.count ?? 0),
      };
      await this.storeMutationReceipt(client, {
        userId: user.id,
        operation: 'event_attachment',
        key,
        fingerprint,
        canonical,
        response,
        resourceType: 'events.event_media',
        resourceId: row.rows[0]!.id,
        resourceVersion: Number(updatedEvent.rows[0]!.version),
        previousAssetId: existingSlot.rows[0]?.asset_id ?? null,
      });
      return response;
    });
  }

  async attachProfile(user: AuthenticatedUser, assetId: string, key: string): Promise<unknown> {
    const canonical = { assetId, profileId: user.id };
    const fingerprint = this.fingerprint('POST', `/media/${assetId}/attach/profile`, canonical);
    return this.database.transaction(async (client) => {
      await this.lockMutationKey(client, user.id, 'profile_attachment', key);
      const replay = await this.mutationReplay(client, user.id, 'profile_attachment', key, fingerprint);
      if (replay !== null) return replay;
      const authorized = await client.query<{
        previous_asset_id: string | null;
        current_owner_id: string;
        purpose: string;
        state: string;
        moderation_state: string;
        url: string | null;
      }>(
        `SELECT profile.avatar_asset_id AS previous_asset_id,
           asset.current_owner_id, asset.purpose, asset.state, asset.moderation_state,
           COALESCE(asset.derivatives->'thumb'->>'url', asset.derivatives->'card'->>'url',
             asset.derivatives->'hero'->>'url') AS url
         FROM identity.profiles profile
         JOIN media.assets asset ON asset.id = $1
         WHERE profile.user_id = $2 AND profile.deleted_at IS NULL
         FOR UPDATE OF profile, asset`,
        [assetId, user.id],
      );
      const binding = authorized.rows[0];
      if (!binding || binding.current_owner_id !== user.id || binding.purpose !== 'profile_avatar') {
        throw new DomainError('MEDIA_ATTACH_FORBIDDEN', '无权将此图片设为头像。', 403);
      }
      this.assertAttachable(binding);
      const updated = await client.query<{ version: string }>(
        `UPDATE identity.profiles SET avatar_asset_id = $1
         WHERE user_id = $2 RETURNING version`,
        [assetId, user.id],
      );
      if (binding.previous_asset_id && binding.previous_asset_id !== assetId) {
        await client.query(
          `UPDATE media.assets old_asset SET state = 'deleted', deleted_at = clock_timestamp(),
             renewal_disabled_at = COALESCE(renewal_disabled_at, clock_timestamp()),
             tombstoned_at = COALESCE(tombstoned_at, clock_timestamp()),
             updated_at = clock_timestamp()
           WHERE old_asset.id = $1 AND old_asset.current_owner_id = $2
             AND old_asset.purpose = 'profile_avatar'
             AND NOT EXISTS (SELECT 1 FROM identity.profiles profile
               WHERE profile.avatar_asset_id = old_asset.id AND profile.deleted_at IS NULL)`,
          [binding.previous_asset_id, user.id],
        );
      }
      const response = { assetId, profileId: user.id, url: binding.url, version: Number(updated.rows[0]!.version) };
      await client.query(
        `SELECT sync.record_change($1, 'profile.avatar.updated', 'profile', $1,
           'upsert', $2, ARRAY['avatarURL'], $3)`,
        [user.id, updated.rows[0]!.version, response],
      );
      const outbox = await client.query<{ event_id: string }>(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('profile',$1,'profile.avatar.updated',$2) RETURNING event_id`,
        [user.id, response],
      );
      await this.storeMutationReceipt(client, {
        userId: user.id,
        operation: 'profile_attachment',
        key,
        fingerprint,
        canonical,
        response,
        resourceType: 'identity.profile',
        resourceId: user.id,
        resourceVersion: Number(updated.rows[0]!.version),
        previousAssetId: binding.previous_asset_id,
        outboxEventId: outbox.rows[0]!.event_id,
      });
      return response;
    });
  }

  async attachGroup(user: AuthenticatedUser, assetId: string, groupId: string, key: string): Promise<unknown> {
    const canonical = { assetId, groupId };
    const fingerprint = this.fingerprint('POST', `/media/${assetId}/attach/group/${groupId}`, canonical);
    return this.database.transaction(async (client) => {
      await this.lockMutationKey(client, user.id, 'group_attachment', key);
      const replay = await this.mutationReplay(client, user.id, 'group_attachment', key, fingerprint);
      if (replay !== null) return replay;
      const authorized = await client.query<{
        previous_asset_id: string | null;
        group_owner_id: string;
        current_owner_id: string;
        purpose: string;
        state: string;
        moderation_state: string;
        url: string | null;
      }>(
        `SELECT group_record.cover_asset_id AS previous_asset_id,
           group_record.owner_id AS group_owner_id,
           asset.current_owner_id, asset.purpose, asset.state, asset.moderation_state,
           COALESCE(asset.derivatives->'hero'->>'url', asset.derivatives->'card'->>'url',
             asset.derivatives->'thumb'->>'url') AS url
         FROM community.groups group_record
         JOIN media.assets asset ON asset.id = $1
         WHERE group_record.id = $2 AND group_record.deleted_at IS NULL
         FOR UPDATE OF group_record, asset`,
        [assetId, groupId],
      );
      const binding = authorized.rows[0];
      if (!binding || binding.group_owner_id !== user.id || binding.current_owner_id !== user.id
        || binding.purpose !== 'group_cover') {
        throw new DomainError('MEDIA_ATTACH_FORBIDDEN', '只有群主可以设置自己上传的群组封面。', 403);
      }
      this.assertAttachable(binding);
      const updated = await client.query<{ version: string }>(
        `UPDATE community.groups SET cover_asset_id = $1
         WHERE id = $2 RETURNING version`,
        [assetId, groupId],
      );
      if (binding.previous_asset_id && binding.previous_asset_id !== assetId) {
        await client.query(
          `UPDATE media.assets old_asset SET state = 'deleted', deleted_at = clock_timestamp(),
             renewal_disabled_at = COALESCE(renewal_disabled_at, clock_timestamp()),
             tombstoned_at = COALESCE(tombstoned_at, clock_timestamp()),
             updated_at = clock_timestamp()
           WHERE old_asset.id = $1 AND old_asset.current_owner_id = $2
             AND old_asset.purpose = 'group_cover'
             AND NOT EXISTS (SELECT 1 FROM community.groups group_record
               WHERE group_record.cover_asset_id = old_asset.id AND group_record.deleted_at IS NULL)`,
          [binding.previous_asset_id, user.id],
        );
      }
      const response = { assetId, groupId, url: binding.url, version: Number(updated.rows[0]!.version) };
      await client.query(
        `SELECT sync.record_change($1, 'group.cover.updated', 'group', $2,
           'upsert', $3, ARRAY['coverURL'], $4)`,
        [user.id, groupId, updated.rows[0]!.version, response],
      );
      const outbox = await client.query<{ event_id: string }>(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('group',$1,'group.cover.updated',$2) RETURNING event_id`,
        [groupId, response],
      );
      await this.storeMutationReceipt(client, {
        userId: user.id,
        operation: 'group_attachment',
        key,
        fingerprint,
        canonical,
        response,
        resourceType: 'community.group',
        resourceId: groupId,
        resourceVersion: Number(updated.rows[0]!.version),
        previousAssetId: binding.previous_asset_id,
        outboxEventId: outbox.rows[0]!.event_id,
      });
      return response;
    });
  }

  async arrangeEvent(
    user: AuthenticatedUser,
    eventId: string,
    input: { orderedAssetIds: string[] },
    key: string,
  ): Promise<unknown> {
    const canonical = { eventId, assetIds: input.orderedAssetIds };
    const fingerprint = this.fingerprint('POST', `/media/events/${eventId}/arrangement`, canonical);
    return this.database.transaction(async (client) => {
      await this.lockMutationKey(client, user.id, 'event_arrangement', key);
      const replay = await this.mutationReplay(client, user.id, 'event_arrangement', key, fingerprint);
      if (replay !== null) return replay;
      const event = await client.query<{ version: string }>(
        `SELECT version FROM events.events
         WHERE id = $1 AND organizer_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [eventId, user.id],
      );
      if (!event.rowCount) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      const existing = await client.query<{ asset_id: string }>(
        `SELECT media_asset_id AS asset_id FROM events.event_media
         WHERE event_id = $1 ORDER BY sort_order, id FOR UPDATE`,
        [eventId],
      );
      const existingIds = existing.rows.map((row) => row.asset_id);
      if (
        existingIds.length !== input.orderedAssetIds.length
        || new Set(existingIds).size !== new Set(input.orderedAssetIds).size
        || input.orderedAssetIds.some((id) => !existingIds.includes(id))
      ) {
        throw new DomainError('MEDIA_ARRANGEMENT_INVALID', '图片顺序必须包含活动当前的全部图片。', 422);
      }
      await client.query(
        `UPDATE events.event_media SET sort_order = sort_order + 100 WHERE event_id = $1`,
        [eventId],
      );
      await client.query(
        `UPDATE events.event_media media
         SET sort_order = ordering.ordinal - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS ordering(asset_id, ordinal)
         WHERE media.event_id = $1 AND media.media_asset_id = ordering.asset_id`,
        [eventId, input.orderedAssetIds],
      );
      const updated = await client.query<{ version: string }>(
        `UPDATE events.events SET updated_by = $2 WHERE id = $1 RETURNING version`,
        [eventId, user.id],
      );
      const response = {
        eventId,
        assetIds: input.orderedAssetIds,
        version: Number(updated.rows[0]!.version),
      };
      await this.storeMutationReceipt(client, {
        userId: user.id,
        operation: 'event_arrangement',
        key,
        fingerprint,
        canonical,
        response,
        resourceType: 'events.event',
        resourceId: eventId,
        resourceVersion: response.version,
      });
      return response;
    });
  }

  private async recoveryResponse(
    client: PoolClient,
    user: AuthenticatedUser,
    initialAsset: AssetRow,
  ): Promise<unknown> {
    let asset = initialAsset;
    let lease = await this.currentLease(client, asset.id, Number(asset.capability_generation), true);
    if (lease?.state === 'failed_clean' && asset.state === 'pending_upload' && !asset.renewal_disabled_at) {
      const rotated = await client.query<AssetRow>(
        `UPDATE media.assets
         SET capability_generation = capability_generation + 1,
             row_version = row_version + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND current_owner_id = $2 AND state = 'pending_upload'
           AND capability_generation = $3 AND renewal_disabled_at IS NULL
         RETURNING *`,
        [asset.id, user.id, asset.capability_generation],
      );
      asset = rotated.rows[0] ?? asset;
      lease = undefined;
    }
    if (lease?.state === 'committed' || asset.authoritative_object_key) {
      if (!lease || lease.state !== 'committed') {
        throw new DomainError('MEDIA_RECOVERY_UNAVAILABLE', '媒体上传状态需要人工核验。', 409);
      }
      return this.committedState(asset, lease);
    }
    if (asset.state !== 'pending_upload' || asset.renewal_disabled_at) {
      return {
        attemptId: asset.upload_attempt_id,
        assetId: asset.id,
        state: asset.state,
        leaseState: lease?.state ?? 'idle',
      };
    }
    if (lease) return this.inProgressState(asset, lease.state);

    if (!asset.upload_attempt_id || !asset.expected_content_hash) {
      throw new DomainError('MEDIA_RECOVERY_UNAVAILABLE', '旧媒体记录无法签发新上传授权。', 409);
    }
    const ttlSeconds = this.numberSetting('MEDIA_GATEWAY_CAPABILITY_TTL_SECONDS', 900, 60, 3_600);
    const requestDeadlineMs = this.numberSetting('MEDIA_GATEWAY_INBOUND_DEADLINE_MS', 30_000, 1_000, 120_000);
    const now = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const expiresAt = new Date(now.rows[0]!.now.getTime() + ttlSeconds * 1_000);
    await client.query(
      `UPDATE media.assets
       SET latest_authorization_expires_at = GREATEST(
         COALESCE(latest_authorization_expires_at, $3), $3
       ), updated_at = clock_timestamp()
       WHERE id = $1 AND current_owner_id = $2`,
      [asset.id, user.id, expiresAt],
    );
    const hash = asset.expected_content_hash.toString('hex');
    const capability = this.capability.issue({
      method: 'PUT',
      routePath: `/v1/media/upload-attempts/${asset.upload_attempt_id}/content`,
      attemptId: asset.upload_attempt_id,
      assetId: asset.id,
      ownerId: user.id,
      generation: Number(asset.capability_generation),
      mimeType: asset.mime_type,
      byteSize: Number(asset.byte_size),
      contentSha256: hash,
      expiresAt: expiresAt.getTime(),
    });
    return {
      attemptId: asset.upload_attempt_id,
      assetId: asset.id,
      state: 'pending_upload',
      uploadUrl: `/v1/media/upload-attempts/${asset.upload_attempt_id}/content`,
      method: 'PUT',
      capability,
      requiredHeaders: {
        'Content-Type': asset.mime_type,
        'Content-Length': asset.byte_size,
        'X-Content-SHA256': hash,
        'X-Spott-Upload-Capability': capability,
      },
      expiresAt: expiresAt.toISOString(),
      maxBytes: Number(asset.byte_size),
      requestDeadlineMs,
    };
  }

  private async commitProviderReceipt(
    asset: AssetRow,
    leaseId: string,
    receipt: ProviderObjectReceipt,
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const leaseUpdated = await client.query<GatewayLeaseRow>(
        `UPDATE media.gateway_upload_leases
         SET state = 'committed', provider_object_version = $4,
             provider_object_checksum = decode($5,'hex'),
             committed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = $2 AND lease_id = $3
           AND state = 'provider_writing'
         RETURNING *`,
        [asset.id, asset.capability_generation, leaseId, receipt.objectVersion, receipt.contentSha256],
      );
      const lease = leaseUpdated.rows[0];
      if (!lease) throw new DomainError('MEDIA_GATEWAY_LEASE_LOST', '上传任务已失去所有权。', 409);
      const assetUpdated = await client.query<AssetRow>(
        `UPDATE media.assets
         SET authoritative_object_key = $4,
             authoritative_object_version = $5,
             authoritative_object_checksum = decode($6,'hex'),
             row_version = row_version + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND current_owner_id = $2
           AND capability_generation = $3 AND row_version = $7
           AND state = 'pending_upload' AND renewal_disabled_at IS NULL
           AND authoritative_object_key IS NULL
           AND authoritative_object_version IS NULL
           AND authoritative_object_checksum IS NULL
         RETURNING *`,
        [
          asset.id,
          asset.current_owner_id,
          asset.capability_generation,
          receipt.objectKey,
          receipt.objectVersion,
          receipt.contentSha256,
          asset.row_version,
        ],
      );
      const committedAsset = assetUpdated.rows[0];
      if (!committedAsset) {
        throw new DomainError('MEDIA_GATEWAY_COMMIT_CONFLICT', '图片上传提交发生冲突。', 409, {
          retryable: true,
        });
      }
      return this.committedState(committedAsset, lease);
    });
  }

  private async markGatewayFailure(
    asset: AssetRow,
    leaseId: string,
    phase: 'receiving' | 'provider_writing',
    receipt: ProviderObjectReceipt | undefined,
    providerAbsenceConfirmed: boolean,
  ): Promise<void> {
    try {
      await this.database.transaction(async (client) => {
        const failed = await client.query(
          `UPDATE media.gateway_upload_leases
           SET state = 'failed_cleanup_pending', failed_at = clock_timestamp(),
               provider_abort_confirmed_at = CASE WHEN $5 THEN clock_timestamp()
                 ELSE provider_abort_confirmed_at END,
               provider_object_version = COALESCE(provider_object_version, $4),
               updated_at = clock_timestamp()
           WHERE asset_id = $1 AND capability_generation = $2 AND lease_id = $3
             AND state = $6`,
          [
            asset.id,
            asset.capability_generation,
            leaseId,
            receipt?.objectVersion ?? null,
            providerAbsenceConfirmed,
            phase,
          ],
        );
        if (failed.rowCount !== 1) return;
        if (phase === 'receiving' || providerAbsenceConfirmed) {
          await client.query(
            `UPDATE media.gateway_upload_leases
             SET state = 'failed_clean', updated_at = clock_timestamp()
             WHERE asset_id = $1 AND capability_generation = $2 AND lease_id = $3
               AND state = 'failed_cleanup_pending'`,
            [asset.id, asset.capability_generation, leaseId],
          );
        }
      });
    } catch {
      // The original safe error wins. The immutable lease remains visible for repair.
    }
  }

  private normalizeIntent(input: IntentInput): IntentInput {
    const filename = input.filename.normalize('NFC');
    if (
      input.byteSize < 1
      || input.byteSize > MAX_MEDIA_UPLOAD_BYTES
      || !/^[a-f0-9]{64}$/u.test(input.contentSha256)
    ) throw new DomainError('MEDIA_INTENT_INVALID', '媒体上传参数无效。', 422);
    return { ...input, filename, contentSha256: input.contentSha256.toLowerCase() };
  }

  private assertCreationAllowed(user: AuthenticatedUser, purpose: ImagePurpose): void {
    if (user.restrictions.includes('publishBlocked') && purpose !== 'report_evidence') {
      throw new DomainError('MEDIA_UPLOAD_RESTRICTED', '当前账号暂不能上传公开内容。', 403);
    }
  }

  private async findAttempt(
    client: PoolClient,
    ownerId: string,
    attemptId: string,
    lock: boolean,
  ): Promise<AssetRow | undefined> {
    const result = await client.query<AssetRow>(
      `SELECT * FROM media.assets
       WHERE current_owner_id = $1 AND upload_attempt_id = $2
       ${lock ? 'FOR UPDATE' : ''}`,
      [ownerId, attemptId],
    );
    return result.rows[0];
  }

  private async findAsset(
    client: PoolClient,
    assetId: string,
    ownerId: string,
    lock: boolean,
  ): Promise<AssetRow | undefined> {
    const result = await client.query<AssetRow>(
      `SELECT * FROM media.assets
       WHERE id = $1 AND current_owner_id = $2
       ${lock ? 'FOR UPDATE' : ''}`,
      [assetId, ownerId],
    );
    return result.rows[0];
  }

  private async currentLease(
    client: PoolClient,
    assetId: string,
    generation: number,
    lock: boolean,
  ): Promise<GatewayLeaseRow | undefined> {
    const result = await client.query<GatewayLeaseRow>(
      `SELECT * FROM media.gateway_upload_leases
       WHERE asset_id = $1 AND capability_generation = $2
       ${lock ? 'FOR UPDATE' : ''}`,
      [assetId, generation],
    );
    return result.rows[0];
  }

  private capabilityMatchesAsset(
    asset: AssetRow,
    capability: ReturnType<MediaCapabilityCodec['verify']>,
  ): boolean {
    return asset.upload_attempt_id === capability.attemptId
      && asset.current_owner_id === capability.ownerId
      && asset.state === 'pending_upload'
      && !asset.renewal_disabled_at
      && !asset.legacy_object_reconciliation_required
      && !asset.authoritative_object_key
      && Number(asset.capability_generation) === capability.generation
      && asset.mime_type === capability.mimeType
      && Number(asset.byte_size) === capability.byteSize
      && asset.expected_content_hash?.toString('hex') === capability.contentSha256;
  }

  private inProgressState(asset: AssetRow, leaseState: string): unknown {
    return {
      attemptId: asset.upload_attempt_id,
      assetId: asset.id,
      state: 'pending_upload',
      leaseState: leaseState === 'receiving' || leaseState === 'provider_writing'
        ? leaseState
        : 'in_progress',
    };
  }

  private committedState(asset: AssetRow, lease: GatewayLeaseRow): unknown {
    if (!lease.committed_at) throw new DomainError('MEDIA_RECOVERY_UNAVAILABLE', '上传回执不完整。', 409);
    return {
      attemptId: asset.upload_attempt_id,
      assetId: asset.id,
      state: asset.state === 'pending_upload' ? 'committed' : asset.state,
      leaseState: 'committed',
      receipt: {
        assetId: asset.id,
        state: 'committed',
        leaseState: 'committed',
        committedAt: lease.committed_at.toISOString(),
      },
    };
  }

  private async lockMutationKey(
    client: PoolClient,
    userId: string,
    operation: string,
    key: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`media:${userId}:${operation}:${key}`],
    );
  }

  private async mutationReplay(
    client: PoolClient,
    userId: string,
    operation: string,
    key: string,
    fingerprint: Buffer,
  ): Promise<Record<string, unknown> | null> {
    const existing = await client.query<MutationReceiptRow>(
      `SELECT request_fingerprint, replay_response
       FROM media.mutation_receipts
       WHERE current_owner_id = $1 AND operation_type = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [userId, operation, key],
    );
    const receipt = existing.rows[0];
    if (!receipt) return null;
    if (!receipt.request_fingerprint.equals(fingerprint)) this.idempotencyConflict();
    return receipt.replay_response;
  }

  private async storeMutationReceipt(client: PoolClient, input: {
    userId: string;
    operation: string;
    key: string;
    fingerprint: Buffer;
    canonical: unknown;
    response: unknown;
    resourceType: string;
    resourceId: string;
    resourceVersion?: number;
    previousAssetId?: string | null;
    outboxEventId?: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO media.mutation_receipts(
         current_owner_id, created_owner_id, operation_type, idempotency_key,
         request_fingerprint, canonical_request, replay_response,
         resource_type, resource_id, resource_version,
         outbox_event_id, previous_asset_id
       ) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.userId,
        input.operation,
        input.key,
        input.fingerprint,
        input.canonical,
        input.response,
        input.resourceType,
        input.resourceId,
        input.resourceVersion ?? null,
        input.outboxEventId ?? null,
        input.previousAssetId ?? null,
      ],
    );
  }

  private fingerprint(method: string, path: string, body: unknown): Buffer {
    return createHash('sha256').update(`${method}\n${path}\n${JSON.stringify(body)}`).digest();
  }

  private numberSetting(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new DomainError('MEDIA_GATEWAY_UNAVAILABLE', '媒体上传时限配置无效。', 503);
    }
    return value;
  }

  private assertAttachable(asset: {
    state: string;
    moderation_state: string;
    url: string | null;
  }): void {
    if (asset.state === 'rejected' || asset.moderation_state === 'rejected') {
      throw new DomainError('MEDIA_REJECTED', '图片未通过安全审核，请重新选择。', 422, {
        retryable: false,
        meta: { state: asset.state, moderationState: asset.moderation_state },
      });
    }
    if (asset.state === 'deleted' || asset.state === 'abandoned') this.assetNotFound();
    if (asset.state !== 'ready' || asset.moderation_state !== 'approved' || !asset.url) {
      throw new DomainError('MEDIA_NOT_READY', '图片仍在处理中，请稍后重试。', 409, {
        retryable: true,
        actions: [{ type: 'retry', label: '稍后重试' }],
        meta: { state: asset.state, moderationState: asset.moderation_state },
      });
    }
  }

  private assetNotFound(): never {
    throw new DomainError('MEDIA_ASSET_NOT_FOUND', '上传任务不存在或已失效。', 404);
  }

  private invalidCapability(): never {
    throw new DomainError('MEDIA_GATEWAY_CAPABILITY_INVALID', '上传授权无效。', 403);
  }

  private gatewayDeadline(): never {
    throw new DomainError('MEDIA_GATEWAY_DEADLINE_EXCEEDED', '图片上传已超时。', 408, {
      retryable: true,
    });
  }

  private hashMismatch(): never {
    throw new DomainError('MEDIA_HASH_MISMATCH', '图片内容校验值不匹配。', 409);
  }

  private idempotencyConflict(): never {
    throw new DomainError('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于不同请求。', 409);
  }
}
