import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

import { createPostgresDatabaseOwnershipCoordinator } from '../../scripts/e2e/database-harness.js';
import { createDatabaseRunIdentity } from '../../scripts/e2e/database-safety.js';
import { loadMigrationManifest } from '../../scripts/e2e/migration-manifest.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const migrationsDirectory = join(repositoryRoot, 'database', 'migrations');
const migrationFilename = '0022_media_upload_attempts.sql';
const postgresAdminURL = process.env.SPOTT_DATABASE_HARNESS_ADMIN_URL;
const postgresTest = postgresAdminURL ? test : test.skip;

function databaseURL(adminURL: string, databaseName: string): string {
  const target = new URL(adminURL);
  target.pathname = `/${databaseName}`;
  return target.toString();
}

async function withOwnedDatabase(
  operation: (client: Client, targetURL: string) => Promise<void>,
): Promise<void> {
  assert.ok(postgresAdminURL, 'SPOTT_DATABASE_HARNESS_ADMIN_URL is required');
  const identity = createDatabaseRunIdentity();
  const targetURL = databaseURL(postgresAdminURL, identity.databaseName);
  const coordinator = createPostgresDatabaseOwnershipCoordinator({
    adminURL: postgresAdminURL,
    targetURL,
    runId: identity.runId,
    runToken: identity.runToken,
  });
  await coordinator.provision();
  const client = new Client({ connectionString: targetURL, application_name: 'spott-task22-test' });
  await client.connect();
  try {
    await operation(client, targetURL);
  } finally {
    await client.end();
    await coordinator.cleanup();
  }
}

async function applyMigrations(client: Client, count = 22): Promise<number> {
  const manifest = await loadMigrationManifest({
    manifestPath: join(repositoryRoot, 'database', 'migration-manifest.json'),
    migrationsDirectory,
  });
  let appliedCount = 0;
  for (const migration of manifest.slice(0, count)) {
    const existing = await client
      .query<{ checksum: string }>(
        'SELECT checksum FROM public.schema_migrations WHERE version = $1',
        [migration.filename],
      )
      .catch(() => ({ rows: [] as { checksum: string }[] }));
    if (existing.rows[0]) {
      assert.equal(existing.rows[0].checksum, migration.sha256);
      continue;
    }
    await client.query(await readFile(join(migrationsDirectory, migration.filename), 'utf8'));
    await client.query('INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)', [
      migration.filename,
      migration.sha256,
    ]);
    appliedCount += 1;
  }
  return appliedCount;
}

async function insertUser(client: Client, id: string, handle: string): Promise<void> {
  await client.query('INSERT INTO identity.users(id, public_handle) VALUES ($1, $2)', [id, handle]);
}

async function claimUploadAttempt(
  client: Client,
  input: {
    ownerId: string;
    attemptId: string;
    intentHashHex: string;
    expectedHashHex?: string;
  },
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO media.assets(
       current_owner_id, created_owner_id, purpose, original_filename, mime_type, byte_size,
       upload_attempt_id, intent_request_hash, expected_content_hash
     ) VALUES (
       $1, $1, 'event_cover', 'fresh.jpg', 'image/jpeg', 16,
       $2, decode($3, 'hex'), decode($4, 'hex')
     )
     ON CONFLICT (current_owner_id, upload_attempt_id)
       WHERE upload_attempt_id IS NOT NULL
     DO UPDATE SET updated_at = assets.updated_at
       WHERE assets.intent_request_hash = EXCLUDED.intent_request_hash
     RETURNING id`,
    [input.ownerId, input.attemptId, input.intentHashHex, input.expectedHashHex ?? 'ab'.repeat(32)],
  );
  return result.rows[0]?.id;
}

class FaultInjectedProviderAdapter {
  putCalls = 0;

  async putObject(input: {
    objectKey: string;
    checksumHex: string;
    version: string;
    delayMs?: number;
    fault?: 'timeout';
  }): Promise<{ objectKey: string; checksumHex: string; version: string }> {
    this.putCalls += 1;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, input.delayMs ?? 0);
    });
    if (input.fault === 'timeout') {
      throw Object.assign(new Error('injected provider timeout'), { code: 'PROVIDER_TIMEOUT' });
    }
    return {
      objectKey: input.objectKey,
      checksumHex: input.checksumHex,
      version: input.version,
    };
  }
}

async function commitGatewayLeaseThroughProvider(
  client: Client,
  provider: FaultInjectedProviderAdapter,
  input: {
    assetId: string;
    generation: number;
    leaseId: string;
    startingRowVersion: number;
    objectKey: string;
    version: string;
    checksumHex: string;
    manifestId: string;
    providerDelayMs?: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO media.gateway_upload_leases(
       asset_id, capability_generation, lease_id, starting_asset_row_version,
       inbound_deadline_at, state, staging_object_key, temp_manifest_id
     ) VALUES (
       $1, $2, $3, $4, clock_timestamp() + interval '1 minute',
       'receiving', $5, $6
     )`,
    [
      input.assetId,
      input.generation,
      input.leaseId,
      input.startingRowVersion,
      input.objectKey,
      input.manifestId,
    ],
  );
  await client.query(
    `UPDATE media.gateway_upload_leases
     SET state = 'provider_writing',
         provider_deadline_at = clock_timestamp() + interval '1 minute',
         updated_at = clock_timestamp()
     WHERE asset_id = $1 AND capability_generation = $2`,
    [input.assetId, input.generation],
  );
  const outcome = await provider.putObject({
    objectKey: input.objectKey,
    checksumHex: input.checksumHex,
    version: input.version,
    delayMs: input.providerDelayMs,
  });
  await client.query(
    `UPDATE media.gateway_upload_leases
     SET state = 'committed', provider_object_version = $3,
         provider_object_checksum = decode($4, 'hex'),
         committed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE asset_id = $1 AND capability_generation = $2`,
    [input.assetId, input.generation, outcome.version, outcome.checksumHex],
  );
  const committed = await client.query(
    `UPDATE media.assets
     SET authoritative_object_key = $4,
         authoritative_object_version = $5,
         authoritative_object_checksum = decode($6, 'hex'),
         row_version = row_version + 1
     WHERE id = $1
       AND capability_generation = $2
       AND row_version = $3
       AND authoritative_object_key IS NULL
       AND authoritative_object_version IS NULL
       AND authoritative_object_checksum IS NULL`,
    [
      input.assetId,
      input.generation,
      input.startingRowVersion,
      outcome.objectKey,
      outcome.version,
      outcome.checksumHex,
    ],
  );
  assert.equal(committed.rowCount, 1);
}

async function insertMutationReceipt(
  client: Client,
  input: {
    ownerId: string;
    operationType: 'event_attachment' | 'event_arrangement';
    idempotencyKey: string;
    resourceId: string;
  },
): Promise<string> {
  const receipt = await client.query<{ id: string }>(
    `INSERT INTO media.mutation_receipts(
       current_owner_id, created_owner_id, operation_type, idempotency_key,
       request_fingerprint, canonical_request, replay_response,
       resource_type, resource_id, resource_version
     ) VALUES (
       $1, $1, $2, $3, decode(repeat('42', 32), 'hex'),
       jsonb_build_object('resourceId', $4::uuid),
       CASE $2
         WHEN 'event_attachment' THEN jsonb_build_object(
           'id', $4::uuid, 'eventId', $4::uuid, 'assetId', $4::uuid,
           'kind', 'cover', 'sortOrder', 0, 'mediaCount', 1
         )
         ELSE jsonb_build_object(
           'eventId', $4::uuid, 'assetIds', jsonb_build_array($4::uuid), 'version', 1
         )
       END,
       'event', $4, 1
     ) RETURNING id`,
    [input.ownerId, input.operationType, input.idempotencyKey, input.resourceId],
  );
  assert.ok(receipt.rows[0]);
  return receipt.rows[0].id;
}

async function insertReportReceipt(
  client: Client,
  input: {
    ownerId: string;
    targetUserId: string;
    idempotencyKey: string;
    ordinal: number;
  },
): Promise<string> {
  const reportId = `a1000000-0000-4000-8000-${String(input.ordinal).padStart(12, '0')}`;
  const caseId = `a2000000-0000-4000-8000-${String(input.ordinal).padStart(12, '0')}`;
  await client.query(
    `INSERT INTO safety.reports(
       id, public_reference, reporter_id, target_type, target_id, reason, severity
     ) VALUES ($1, $2, $3, 'user', $4, 'merge fixture', 'p2')`,
    [reportId, `SPOTT-MERGE-${input.ordinal}`, input.ownerId, input.targetUserId],
  );
  await client.query(
    `INSERT INTO safety.moderation_cases(id, report_id, sla_due_at)
     VALUES ($1, $2, clock_timestamp() + interval '1 day')`,
    [caseId, reportId],
  );
  const receipt = await client.query<{ id: string }>(
    `INSERT INTO media.mutation_receipts(
       current_owner_id, created_owner_id, operation_type, idempotency_key,
       request_fingerprint, canonical_request, replay_response,
       resource_type, resource_id, resource_version,
       report_target_type, report_target_id, report_category,
       report_description_hash, report_id, safety_case_id
     ) VALUES (
       $1, $1, 'report_submission', $2, decode(repeat('43', 32), 'hex'),
       jsonb_build_object('targetId', $3::uuid, 'category', 'other'),
       jsonb_build_object('reportId', $4::uuid, 'caseId', $5::uuid),
       'safety.report', $4, 1,
       'user', $3, 'other', decode(repeat('44', 32), 'hex'), $4, $5
     ) RETURNING id`,
    [input.ownerId, input.idempotencyKey, input.targetUserId, reportId, caseId],
  );
  assert.ok(receipt.rows[0]);
  return receipt.rows[0].id;
}

void test('appends immutable migration 0022 with an exact manifest checksum', async () => {
  const manifest = await loadMigrationManifest({
    manifestPath: join(repositoryRoot, 'database', 'migration-manifest.json'),
    migrationsDirectory,
  });

  assert.equal(manifest.length, 22);
  assert.deepEqual(manifest.at(-1), {
    sequence: 22,
    filename: migrationFilename,
    sha256: createHash('sha256')
      .update(await readFile(join(migrationsDirectory, migrationFilename)))
      .digest('hex'),
  });
});

void test('runtime media SQL authorizes only current owners and names legacy or authoritative keys explicitly', async () => {
  const runtimePaths = [
    'services/api/src/modules/media/media.service.ts',
    'services/api/src/modules/auth/auth.service.ts',
    'services/worker/src/media.ts',
  ];
  for (const relativePath of runtimePaths) {
    const source = await readFile(join(repositoryRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /\b(?:asset|a|old_asset)\.owner_id\b/u, relativePath);
    assert.doesNotMatch(source, /UPDATE\s+media\.assets\s+SET\s+owner_id\b/u, relativePath);
    assert.doesNotMatch(
      source,
      /INSERT\s+INTO\s+media\.assets\s*\([^)]*\bowner_id\b/su,
      relativePath,
    );
    assert.doesNotMatch(source, /\b(?:asset|a)\.object_key\b/u, relativePath);
    assert.doesNotMatch(
      source,
      /SELECT[^;`]*\bobject_key\b[^;`]*FROM\s+media\.assets/su,
      relativePath,
    );
    assert.doesNotMatch(source, /RETURNING[^;`]*\bobject_key\b/su, relativePath);
    assert.doesNotMatch(
      source,
      /WHERE[^;`]*created_owner_id|JOIN[^;`]*created_owner_id/su,
      relativePath,
    );
    for (const occurrence of source.matchAll(/created_owner_id/gu)) {
      const context = source.slice(Math.max(0, occurrence.index - 180), occurrence.index + 40);
      assert.match(context, /INSERT INTO media\.assets\s*\(/u, relativePath);
    }
  }

  const workerSource = await readFile(join(repositoryRoot, 'services/worker/src/media.ts'), 'utf8');
  assert.match(workerSource, /legacy_object_reconciliation_required = false/u);
  assert.match(workerSource, /authoritative_object_key IS NOT NULL/u);
});

void postgresTest(
  'replays onto an empty PostgreSQL database and installs the durable media schema',
  async () => {
    await withOwnedDatabase(async (client) => {
      assert.equal(await applyMigrations(client), 22);
      assert.equal(await applyMigrations(client), 0);

      const columns = await client.query<{
        column_name: string;
        is_nullable: 'YES' | 'NO';
      }>(
        `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'media' AND table_name = 'assets'`,
      );
      const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

      assert.equal(byName.has('owner_id'), false);
      assert.equal(byName.has('object_key'), false);
      for (const required of [
        'current_owner_id',
        'created_owner_id',
        'legacy_preallocated_object_key',
        'authoritative_object_key',
        'authoritative_object_version',
        'authoritative_object_checksum',
        'legacy_object_reconciliation_required',
        'upload_attempt_id',
        'intent_request_hash',
        'expected_content_hash',
        'capability_generation',
        'latest_authorization_expires_at',
        'authorization_clock_skew',
        'renewal_disabled_at',
        'cleanup_not_before',
        'abandoned_at',
        'tombstoned_at',
        'row_version',
        'processing_generation',
        'processing_lease_id',
        'processing_lease_expires_at',
      ]) {
        assert.ok(byName.has(required), `missing media.assets.${required}`);
      }
      assert.equal(byName.get('current_owner_id')?.is_nullable, 'NO');
      assert.equal(byName.get('created_owner_id')?.is_nullable, 'NO');
      assert.equal(byName.get('processing_generation')?.is_nullable, 'NO');
      assert.equal(byName.get('row_version')?.is_nullable, 'NO');

      const relations = await client.query<{ relation: string | null }>(
        `SELECT unnest(ARRAY[
         to_regclass('media.completion_receipts')::text,
         to_regclass('media.mutation_receipts')::text,
         to_regclass('media.gateway_upload_leases')::text,
         to_regclass('media.worker_processing_leases')::text,
         to_regclass('media.object_cleanup_tasks')::text,
         to_regclass('media.legacy_asset_reference_quarantine')::text,
         to_regclass('safety.evidence_asset_quarantine')::text
       ]) AS relation`,
      );
      assert.deepEqual(
        relations.rows.map((row) => row.relation),
        [
          'media.completion_receipts',
          'media.mutation_receipts',
          'media.gateway_upload_leases',
          'media.worker_processing_leases',
          'media.object_cleanup_tasks',
          'media.legacy_asset_reference_quarantine',
          'safety.evidence_asset_quarantine',
        ],
      );
      const quarantineRLS = await client.query<{
        schema_name: string;
        table_name: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT namespace.nspname AS schema_name, relation.relname AS table_name,
              relation.relrowsecurity, relation.relforcerowsecurity
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE (namespace.nspname, relation.relname) IN (
         ('media', 'legacy_asset_reference_quarantine'),
         ('safety', 'evidence_asset_quarantine')
       )
       ORDER BY namespace.nspname, relation.relname`,
      );
      assert.deepEqual(quarantineRLS.rows, [
        {
          schema_name: 'media',
          table_name: 'legacy_asset_reference_quarantine',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          schema_name: 'safety',
          table_name: 'evidence_asset_quarantine',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ]);
    });
  },
);

void postgresTest(
  'upgrades legacy assets, outbox history, and evidence without fabricating recovery data',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client, 21);
      const ownerId = '10000000-0000-4000-8000-000000000001';
      const otherOwnerId = '10000000-0000-4000-8000-000000000002';
      const reportId = '20000000-0000-4000-8000-000000000001';
      const missingAssetId = '30000000-0000-4000-8000-000000000099';
      const assets = {
        pending_upload: '30000000-0000-4000-8000-000000000001',
        uploaded: '30000000-0000-4000-8000-000000000002',
        processing: '30000000-0000-4000-8000-000000000003',
        ready: '30000000-0000-4000-8000-000000000004',
        rejected: '30000000-0000-4000-8000-000000000005',
        deleted: '30000000-0000-4000-8000-000000000006',
      } as const;
      const publishedEventId = '40000000-0000-4000-8000-000000000001';
      const duplicateEventId = '40000000-0000-4000-8000-000000000002';

      await client.query(
        `INSERT INTO identity.users(id, public_handle)
       VALUES ($1, 'legacy_owner'), ($2, 'legacy_other')`,
        [ownerId, otherOwnerId],
      );
      for (const [state, assetId] of Object.entries(assets)) {
        await client.query(
          `INSERT INTO media.assets(
           id, owner_id, purpose, object_key, original_filename, mime_type,
           byte_size, content_hash, state, uploaded_at, ready_at, deleted_at
         )
         VALUES (
           $1, $2, 'report_evidence', $3, 'legacy.jpg', 'image/jpeg', 16,
           CASE WHEN $4 IN ('uploaded', 'processing', 'ready')
             THEN decode(repeat('ab', 32), 'hex') ELSE NULL END,
           $4,
           CASE WHEN $4 IN ('uploaded', 'processing', 'ready', 'rejected')
             THEN clock_timestamp() ELSE NULL END,
           CASE WHEN $4 = 'ready' THEN clock_timestamp() ELSE NULL END,
           CASE WHEN $4 = 'deleted' THEN clock_timestamp() ELSE NULL END
         )`,
          [assetId, ownerId, `legacy/${state}/${assetId}`, state],
        );
      }
      await client.query(
        `INSERT INTO sync.outbox_events(
         event_id, aggregate, aggregate_id, type, payload, published_at, created_at
       ) VALUES
       ($1, 'media.asset', $3, 'media.processing_requested', '{}'::jsonb,
        clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '3 minutes'),
       ($2, 'media.asset', $3, 'media.processing_requested', '{}'::jsonb,
        NULL, clock_timestamp() - interval '4 minutes')`,
        [publishedEventId, duplicateEventId, assets.uploaded],
      );
      await client.query(
        `INSERT INTO sync.dead_letter_events(
         outbox_event_id, aggregate, aggregate_id, type, payload, attempt_count, last_error
       ) VALUES ($1, 'media.asset', $2, 'media.processing_requested', '{}'::jsonb, 20, 'legacy')`,
        [duplicateEventId, assets.uploaded],
      );
      await client.query(
        `INSERT INTO sync.idempotency_keys(
         key, user_id, request_hash, response_code, response_body,
         resource_type, resource_id, expires_at
       ) VALUES (
         '41000000-0000-4000-8000-000000000001', $1,
         decode(repeat('aa', 32), 'hex'), 201,
         jsonb_build_object(
           'assetId', $2::uuid,
           'uploadUrl', 'https://gateway.invalid/legacy-secret',
           'requiredHeaders', jsonb_build_object('X-Spott-Upload-Capability', 'secret')
         ),
         'media.upload_intent', $2, clock_timestamp() + interval '1 day'
       )`,
        [ownerId, assets.pending_upload],
      );
      await client.query(
        `INSERT INTO safety.reports(
         id, public_reference, reporter_id, target_type, target_id, reason, severity
       ) VALUES ($1, 'SPOTT-LEGACY-1', $2, 'user', $3, 'legacy', 'p2')`,
        [reportId, ownerId, otherOwnerId],
      );
      await client.query(
        `INSERT INTO events.events(id, public_slug, organizer_id, title)
       VALUES ('25000000-0000-4000-8000-000000000001', 'legacy-media-event', $1, 'Legacy media')`,
        [ownerId],
      );
      await client.query(
        `INSERT INTO events.event_media(
         id, event_id, asset_id, media_asset_id, sort_order, content_hash
       ) VALUES
       ('26000000-0000-4000-8000-000000000001',
        '25000000-0000-4000-8000-000000000001', $1, NULL, 0,
        decode(repeat('ef', 32), 'hex')),
       ('26000000-0000-4000-8000-000000000002',
        '25000000-0000-4000-8000-000000000001', $2, NULL, 1, NULL)`,
        [assets.ready, missingAssetId],
      );
      await client.query(
        `INSERT INTO safety.evidence_assets(
         id, report_id, asset_id, kms_key_ref, content_hash, retention_until, created_at
       ) VALUES
       ('50000000-0000-4000-8000-000000000001', $1, $2, 'kms/legacy',
        decode(repeat('ab', 32), 'hex'), clock_timestamp() + interval '30 days',
        clock_timestamp() - interval '2 minutes'),
       ('50000000-0000-4000-8000-000000000002', $1, $3, 'kms/orphan',
        decode(repeat('cd', 32), 'hex'), clock_timestamp() + interval '30 days',
        clock_timestamp() - interval '1 minute'),
       ('50000000-0000-4000-8000-000000000003', $1, $4, 'kms/fake-hash',
        decode(repeat('ef', 32), 'hex'), clock_timestamp() + interval '30 days',
        clock_timestamp())`,
        [reportId, assets.ready, missingAssetId, assets.processing],
      );

      assert.equal(await applyMigrations(client), 1);

      const upgraded = await client.query<{
        id: string;
        state: string;
        current_owner_id: string;
        created_owner_id: string;
        legacy_preallocated_object_key: string;
        authoritative_object_key: string | null;
        authoritative_object_version: string | null;
        authoritative_object_checksum: Buffer | null;
        legacy_object_reconciliation_required: boolean;
        upload_attempt_id: string | null;
        expected_content_hash: Buffer | null;
        processing_generation: string;
        row_version: string;
        renewal_disabled_at: Date | null;
        tombstoned_at: Date | null;
      }>(
        `SELECT id, state, current_owner_id, created_owner_id,
              legacy_preallocated_object_key, authoritative_object_key,
              authoritative_object_version, authoritative_object_checksum,
              legacy_object_reconciliation_required, upload_attempt_id,
              expected_content_hash, processing_generation, row_version,
              renewal_disabled_at, tombstoned_at
       FROM media.assets
       ORDER BY id`,
      );
      assert.equal(upgraded.rows.length, 6);
      for (const row of upgraded.rows) {
        assert.equal(row.current_owner_id, ownerId);
        assert.equal(row.created_owner_id, ownerId);
        assert.equal(row.upload_attempt_id, null);
        assert.equal(row.expected_content_hash, null);
        assert.equal(row.processing_generation, '0');
        assert.equal(row.row_version, '0');
        assert.ok(row.legacy_preallocated_object_key.startsWith('legacy/'));
      }
      const byState = new Map(upgraded.rows.map((row) => [row.state, row]));
      assert.equal(byState.get('pending_upload')?.authoritative_object_key, null);
      assert.equal(byState.get('pending_upload')?.legacy_object_reconciliation_required, false);
      for (const state of ['uploaded', 'processing', 'ready', 'rejected']) {
        const row = byState.get(state);
        assert.equal(row?.authoritative_object_key, row?.legacy_preallocated_object_key);
        assert.equal(row?.authoritative_object_version, null);
        assert.equal(row?.authoritative_object_checksum, null);
        assert.equal(row?.legacy_object_reconciliation_required, true);
      }
      assert.equal(byState.get('deleted')?.authoritative_object_key, null);
      assert.ok(byState.get('deleted')?.renewal_disabled_at);
      assert.ok(byState.get('deleted')?.tombstoned_at);

      await assert.rejects(
        client.query('UPDATE media.assets SET created_owner_id = $2 WHERE id = $1', [
          assets.pending_upload,
          otherOwnerId,
        ]),
        /created owner is immutable/u,
      );
      await assert.rejects(
        client.query(
          `UPDATE media.assets
         SET authoritative_object_key = legacy_preallocated_object_key,
             authoritative_object_version = 'forged-legacy-version',
             authoritative_object_checksum = decode(repeat('aa', 32), 'hex')
         WHERE id = $1`,
          [assets.pending_upload],
        ),
        /legacy preallocated object cannot become authoritative/u,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media.gateway_upload_leases(
           asset_id, capability_generation, lease_id, starting_asset_row_version,
           inbound_deadline_at, state, staging_object_key, temp_manifest_id
         ) VALUES (
           $1, 0, '61000000-0000-4000-8000-000000000001', 0,
           clock_timestamp() + interval '1 minute', 'receiving',
           'private/legacy-pending/forbidden',
           '61000000-0000-4000-8000-000000000002'
         )`,
          [assets.pending_upload],
        ),
        /gateway lease requires a recoverable upload attempt/u,
      );
      await assert.rejects(
        client.query(
          `UPDATE media.assets
         SET processing_generation = processing_generation + 1
         WHERE id = $1`,
          [assets.uploaded],
        ),
        /unreconciled legacy asset is frozen/u,
      );
      await assert.rejects(
        client.query(
          `UPDATE media.assets
         SET latest_authorization_expires_at = clock_timestamp() + interval '15 minutes'
         WHERE id = $1`,
          [assets.ready],
        ),
        /unreconciled legacy asset is frozen/u,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media.object_cleanup_tasks(
           asset_id, object_kind, object_key, cleanup_not_before
         ) VALUES ($1, 'authoritative_original', $2, clock_timestamp())`,
          [assets.ready, `legacy/ready/${assets.ready}`],
        ),
        /unreconciled legacy object cannot be destructively cleaned/u,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO identity.profiles(user_id, nickname, avatar_asset_id)
         VALUES ($1, 'Unsafe', $2)`,
          [ownerId, assets.ready],
        ),
        /unreconciled legacy asset cannot be attached/u,
      );

      const workerLeaseId = '60000000-0000-4000-8000-000000000001';
      await client.query(
        `UPDATE media.assets
       SET authoritative_object_version = 'legacy-version-1',
           authoritative_object_checksum = decode(repeat('ab', 32), 'hex'),
           legacy_object_reconciliation_required = false,
           legacy_object_reconciled_at = clock_timestamp()
       WHERE id = $1`,
        [assets.uploaded],
      );
      const claimed = await client.query<{ row_version: string; processing_generation: string }>(
        `UPDATE media.assets
       SET state = 'processing',
           processing_generation = processing_generation + 1,
           processing_lease_id = $2,
           processing_lease_expires_at = clock_timestamp() + interval '5 minutes',
           row_version = row_version + 1
       WHERE id = $1 AND state = 'uploaded' AND row_version = 0
       RETURNING row_version, processing_generation`,
        [assets.uploaded, workerLeaseId],
      );
      assert.deepEqual(claimed.rows, [{ row_version: '1', processing_generation: '1' }]);
      const finalized = await client.query(
        `UPDATE media.assets
       SET state = 'ready', processing_lease_id = NULL, processing_lease_expires_at = NULL,
           row_version = row_version + 1, ready_at = clock_timestamp()
       WHERE id = $1 AND row_version = 1 AND processing_generation = 1
         AND processing_lease_id = $2`,
        [assets.uploaded, workerLeaseId],
      );
      assert.equal(finalized.rowCount, 1);
      const stale = await client.query(
        `UPDATE media.assets SET failure_code = 'stale'
       WHERE id = $1 AND row_version = 1 AND processing_generation = 1
         AND processing_lease_id = $2`,
        [assets.uploaded, workerLeaseId],
      );
      assert.equal(stale.rowCount, 0);

      const processingEvents = await client.query<{
        event_id: string;
        type: string;
        published_at: Date | null;
      }>(
        `SELECT event_id, type, published_at
       FROM sync.outbox_events
       WHERE aggregate_id = $1 ORDER BY event_id`,
        [assets.uploaded],
      );
      assert.equal(
        processingEvents.rows.filter((row) => row.type === 'media.processing_requested').length,
        1,
      );
      assert.equal(
        processingEvents.rows.find((row) => row.type === 'media.processing_requested')?.event_id,
        publishedEventId,
      );
      assert.ok(
        processingEvents.rows.find(
          (row) => row.type === 'media.processing_requested.legacy_duplicate',
        )?.published_at,
      );
      const receipt = await client.query<{ outbox_event_id: string | null }>(
        'SELECT outbox_event_id FROM media.completion_receipts WHERE asset_id = $1',
        [assets.uploaded],
      );
      assert.equal(receipt.rows[0]?.outbox_event_id, publishedEventId);
      const deadLetter = await client.query<{ outbox_event_id: string }>(
        'SELECT outbox_event_id FROM sync.dead_letter_events WHERE outbox_event_id = $1',
        [duplicateEventId],
      );
      assert.equal(deadLetter.rows[0]?.outbox_event_id, duplicateEventId);

      const retainedEvidence = await client.query<{
        asset_id: string;
        sort_order: number;
        content_hash: Buffer;
      }>('SELECT asset_id, sort_order, content_hash FROM safety.evidence_assets');
      assert.equal(retainedEvidence.rows.length, 1);
      assert.equal(retainedEvidence.rows[0]?.asset_id, assets.ready);
      assert.equal(retainedEvidence.rows[0]?.sort_order, 0);
      assert.equal(retainedEvidence.rows[0]?.content_hash.toString('hex'), 'ab'.repeat(32));
      const quarantined = await client.query<{ asset_id: string; reason: string }>(
        'SELECT asset_id, reason FROM safety.evidence_asset_quarantine ORDER BY asset_id',
      );
      assert.deepEqual(quarantined.rows, [
        { asset_id: assets.processing, reason: 'legacy_hash_mismatch' },
        { asset_id: missingAssetId, reason: 'missing_media_asset' },
      ]);
      await assert.rejects(
        client.query(
          `UPDATE safety.evidence_asset_quarantine
         SET quarantined_at = clock_timestamp()
         WHERE asset_id = $1`,
          [assets.processing],
        ),
        /evidence_asset_quarantine is append-only/u,
      );
      const safeLegacyReplay = await client.query<{ response_body: Record<string, unknown> }>(
        `SELECT response_body FROM sync.idempotency_keys
       WHERE key = '41000000-0000-4000-8000-000000000001'`,
      );
      assert.deepEqual(safeLegacyReplay.rows[0]?.response_body, {
        resourceId: assets.pending_upload,
        resourceType: 'media.upload_intent',
        state: 'pending_upload',
      });
      const eventReferences = await client.query<{
        id: string;
        asset_id: string;
        media_asset_id: string | null;
        content_hash: Buffer | null;
      }>(
        `SELECT id, asset_id, media_asset_id, content_hash
       FROM events.event_media ORDER BY sort_order`,
      );
      assert.equal(eventReferences.rows[0]?.media_asset_id, assets.ready);
      assert.equal(eventReferences.rows[0]?.content_hash?.toString('hex'), 'ab'.repeat(32));
      assert.equal(eventReferences.rows[1]?.media_asset_id, null);
      const quarantinedReference = await client.query<{
        reference_id: string;
        asset_id: string;
        reason: string;
      }>('SELECT reference_id, asset_id, reason FROM media.legacy_asset_reference_quarantine');
      assert.deepEqual(quarantinedReference.rows, [
        {
          reference_id: '26000000-0000-4000-8000-000000000002',
          asset_id: missingAssetId,
          reason: 'missing_media_asset',
        },
      ]);
      const deletedCleanup = await client.query<{ object_key: string }>(
        `SELECT object_key FROM media.object_cleanup_tasks
       WHERE asset_id = $1 AND object_kind = 'legacy_preallocated'`,
        [assets.deleted],
      );
      assert.equal(deletedCleanup.rows[0]?.object_key, `legacy/deleted/${assets.deleted}`);
    });
  },
);

void postgresTest(
  'serializes attempt, lease, cleanup, and abandon-complete races in PostgreSQL',
  async () => {
    await withOwnedDatabase(async (client, targetURL) => {
      await applyMigrations(client);
      const ownerA = '70000000-0000-4000-8000-000000000001';
      const ownerB = '70000000-0000-4000-8000-000000000002';
      const attemptId = '71000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerA, 'race_owner_a');
      await insertUser(client, ownerB, 'race_owner_b');

      const first = new Client({
        connectionString: targetURL,
        application_name: 'spott-task22-race-a',
      });
      const second = new Client({
        connectionString: targetURL,
        application_name: 'spott-task22-race-b',
      });
      await Promise.all([first.connect(), second.connect()]);
      try {
        const sameAttempt = await Promise.all([
          claimUploadAttempt(first, {
            ownerId: ownerA,
            attemptId,
            intentHashHex: '11'.repeat(32),
          }),
          claimUploadAttempt(second, {
            ownerId: ownerA,
            attemptId,
            intentHashHex: '11'.repeat(32),
          }),
        ]);
        assert.ok(sameAttempt[0]);
        assert.equal(sameAttempt[0], sameAttempt[1]);
        const assetId = sameAttempt[0];

        const crossOwnerAsset = await claimUploadAttempt(second, {
          ownerId: ownerB,
          attemptId,
          intentHashHex: '11'.repeat(32),
        });
        assert.ok(crossOwnerAsset);
        assert.notEqual(crossOwnerAsset, assetId);
        assert.equal(
          await claimUploadAttempt(second, {
            ownerId: ownerA,
            attemptId,
            intentHashHex: '22'.repeat(32),
          }),
          undefined,
        );
        const attempts = await client.query<{ current_owner_id: string; id: string }>(
          'SELECT current_owner_id, id FROM media.assets WHERE upload_attempt_id = $1 ORDER BY current_owner_id',
          [attemptId],
        );
        assert.deepEqual(attempts.rows, [
          { current_owner_id: ownerA, id: assetId },
          { current_owner_id: ownerB, id: crossOwnerAsset },
        ]);

        await assert.rejects(
          client.query(
            `UPDATE media.assets SET expected_content_hash = decode(repeat('cd', 32), 'hex')
           WHERE id = $1`,
            [assetId],
          ),
          /expected content hash is immutable/u,
        );
        await assert.rejects(
          client.query(`UPDATE media.assets SET upload_attempt_id = $2 WHERE id = $1`, [
            assetId,
            '71000000-0000-4000-8000-000000000099',
          ]),
          /upload attempt is immutable/u,
        );
        await assert.rejects(
          client.query(
            `UPDATE media.assets
           SET authoritative_object_key = 'private/no-lease',
               authoritative_object_version = 'no-lease-version',
               authoritative_object_checksum = decode(repeat('ab', 32), 'hex'),
               row_version = row_version + 1
           WHERE id = $1`,
            [assetId],
          ),
          /authoritative object requires the committed generation lease/u,
        );

        const leaseA = '72000000-0000-4000-8000-000000000001';
        const leaseB = '72000000-0000-4000-8000-000000000002';
        const manifestA = '73000000-0000-4000-8000-000000000001';
        const manifestB = '73000000-0000-4000-8000-000000000002';
        const provider = new FaultInjectedProviderAdapter();
        const leaseClaims = await Promise.all([
          first.query<{ lease_id: string }>(
            `INSERT INTO media.gateway_upload_leases(
             asset_id, capability_generation, lease_id, starting_asset_row_version,
             inbound_deadline_at, state, staging_object_key, temp_manifest_id
           ) VALUES ($1, 0, $2, 0, clock_timestamp() + interval '1 minute',
                     'receiving', 'private/g0/a', $3)
           ON CONFLICT (asset_id, capability_generation) DO NOTHING
           RETURNING lease_id`,
            [assetId, leaseA, manifestA],
          ),
          second.query<{ lease_id: string }>(
            `INSERT INTO media.gateway_upload_leases(
             asset_id, capability_generation, lease_id, starting_asset_row_version,
             inbound_deadline_at, state, staging_object_key, temp_manifest_id
           ) VALUES ($1, 0, $2, 0, clock_timestamp() + interval '1 minute',
                     'receiving', 'private/g0/b', $3)
           ON CONFLICT (asset_id, capability_generation) DO NOTHING
           RETURNING lease_id`,
            [assetId, leaseB, manifestB],
          ),
        ]);
        assert.equal(leaseClaims.filter((result) => result.rowCount === 1).length, 1);
        const winningFailedLease = leaseClaims[0]?.rowCount === 1 ? leaseA : leaseB;
        const failedKey = leaseClaims[0]?.rowCount === 1 ? 'private/g0/a' : 'private/g0/b';
        await client.query(
          `UPDATE media.gateway_upload_leases
         SET state = 'provider_writing',
             provider_deadline_at = clock_timestamp() + interval '100 milliseconds',
             updated_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = 0`,
          [assetId],
        );
        await assert.rejects(
          provider.putObject({
            objectKey: failedKey,
            checksumHex: 'ab'.repeat(32),
            version: 'uncommitted-timeout-version',
            delayMs: 10,
            fault: 'timeout',
          }),
          /injected provider timeout/u,
        );
        await client.query(
          `UPDATE media.gateway_upload_leases
         SET state = 'failed_cleanup_pending', failed_at = clock_timestamp(),
             provider_abort_confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = 0`,
          [assetId],
        );
        await client.query(
          `INSERT INTO media.object_cleanup_tasks(
           asset_id, object_kind, object_key, capability_generation, lease_id, cleanup_not_before
         ) VALUES ($1, 'gateway_staging', $2, 0, $3,
                   media.cleanup_fence_for_asset($1))`,
          [assetId, failedKey, winningFailedLease],
        );
        await assert.rejects(
          client.query(
            `UPDATE media.object_cleanup_tasks
           SET object_key = 'private/g0/tampered'
           WHERE asset_id = $1 AND capability_generation = 0`,
            [assetId],
          ),
          /cleanup object identity is immutable/u,
        );

        await client.query(
          `UPDATE media.assets
         SET capability_generation = capability_generation + 1, row_version = row_version + 1
         WHERE id = $1 AND capability_generation = 0`,
          [assetId],
        );
        const committedLeaseId = '72000000-0000-4000-8000-000000000003';
        const committedKey = 'private/g1/winner';
        const committedVersion = 'version-winner';
        await commitGatewayLeaseThroughProvider(client, provider, {
          assetId,
          generation: 1,
          leaseId: committedLeaseId,
          startingRowVersion: 1,
          objectKey: committedKey,
          version: committedVersion,
          checksumHex: 'ab'.repeat(32),
          manifestId: '73000000-0000-4000-8000-000000000003',
        });
        assert.equal(provider.putCalls, 2);
        assert.notEqual(failedKey, committedKey);
        await client.query(
          `UPDATE media.object_cleanup_tasks
         SET state = 'verified_absent', verification_state = 'absence_verified',
             completed_at = clock_timestamp(),
             cleanup_not_before = media.cleanup_fence_for_asset($1)
         WHERE asset_id = $1 AND capability_generation = 0`,
          [assetId],
        );
        await assert.rejects(
          client.query(
            `INSERT INTO media.object_cleanup_tasks(
             asset_id, object_kind, object_key, object_version,
             capability_generation, lease_id, cleanup_not_before
           ) VALUES ($1, 'gateway_staging', $2, $3, 0, $4, clock_timestamp())`,
            [assetId, committedKey, committedVersion, winningFailedLease],
          ),
          /losing cleanup cannot target the authoritative object/u,
        );
        await assert.rejects(
          client.query(
            `UPDATE media.gateway_upload_leases
           SET provider_object_version = 'tampered-version'
           WHERE asset_id = $1 AND capability_generation = 1`,
            [assetId],
          ),
          /committed gateway receipt is immutable/u,
        );

        const raceAttempt = '71000000-0000-4000-8000-000000000002';
        const raceAsset = await claimUploadAttempt(client, {
          ownerId: ownerA,
          attemptId: raceAttempt,
          intentHashHex: '33'.repeat(32),
        });
        assert.ok(raceAsset);
        const raceProvider = new FaultInjectedProviderAdapter();
        await commitGatewayLeaseThroughProvider(client, raceProvider, {
          assetId: raceAsset,
          generation: 0,
          leaseId: '74000000-0000-4000-8000-000000000001',
          startingRowVersion: 0,
          objectKey: 'private/race/winner',
          version: 'race-version',
          checksumHex: 'ab'.repeat(32),
          manifestId: '75000000-0000-4000-8000-000000000001',
        });
        assert.equal(raceProvider.putCalls, 1);
        const outcomes = await Promise.all([
          first.query(
            `UPDATE media.assets
           SET state = 'uploaded', content_hash = expected_content_hash,
               uploaded_at = clock_timestamp(), row_version = row_version + 1
           WHERE id = $1 AND state = 'pending_upload' AND row_version = 1`,
            [raceAsset],
          ),
          second.query(
            `UPDATE media.assets
           SET state = 'abandoned', abandoned_at = clock_timestamp(),
               renewal_disabled_at = clock_timestamp(), tombstoned_at = clock_timestamp(),
               cleanup_not_before = clock_timestamp(), row_version = row_version + 1
           WHERE id = $1 AND state = 'pending_upload' AND row_version = 1`,
            [raceAsset],
          ),
        ]);
        assert.equal(
          outcomes.reduce((sum, result) => sum + (result.rowCount ?? 0), 0),
          1,
        );
        const terminal = await client.query<{ state: string; row_version: string }>(
          'SELECT state, row_version FROM media.assets WHERE id = $1',
          [raceAsset],
        );
        assert.ok(['uploaded', 'abandoned'].includes(terminal.rows[0]?.state ?? ''));
        assert.equal(terminal.rows[0]?.row_version, '2');
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
    });
  },
);

void postgresTest(
  'serializes a winning provider commit against a second DB lease claim before any second PUT',
  async () => {
    await withOwnedDatabase(async (client, targetURL) => {
      await applyMigrations(client);
      const ownerId = '7a000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerId, 'provider_race_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: '7a000000-0000-4000-8000-000000000002',
        intentHashHex: '3a'.repeat(32),
        expectedHashHex: 'ab'.repeat(32),
      });
      assert.ok(assetId);

      const winner = new Client({
        connectionString: targetURL,
        application_name: 'spott-task22-provider-winner',
      });
      const loser = new Client({
        connectionString: targetURL,
        application_name: 'spott-task22-provider-loser',
      });
      const provider = new FaultInjectedProviderAdapter();
      await Promise.all([winner.connect(), loser.connect()]);
      try {
        await winner.query('BEGIN');
        await winner.query(
          `INSERT INTO media.gateway_upload_leases(
           asset_id, capability_generation, lease_id, starting_asset_row_version,
           inbound_deadline_at, state, staging_object_key, temp_manifest_id
         ) VALUES (
           $1, 0, '7a000000-0000-4000-8000-000000000003', 0,
           clock_timestamp() + interval '1 minute', 'receiving',
           'private/provider-race/winner', '7a000000-0000-4000-8000-000000000004'
         )`,
          [assetId],
        );
        await winner.query(
          `UPDATE media.gateway_upload_leases
         SET state = 'provider_writing',
             provider_deadline_at = clock_timestamp() + interval '1 minute',
             updated_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = 0`,
          [assetId],
        );

        const winnerCompletion = (async () => {
          const outcome = await provider.putObject({
            objectKey: 'private/provider-race/winner',
            checksumHex: 'ab'.repeat(32),
            version: 'provider-race-version',
            delayMs: 300,
          });
          await winner.query(
            `UPDATE media.gateway_upload_leases
           SET state = 'committed', provider_object_version = $2,
               provider_object_checksum = decode($3, 'hex'),
               committed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE asset_id = $1 AND capability_generation = 0`,
            [assetId, outcome.version, outcome.checksumHex],
          );
          const committed = await winner.query(
            `UPDATE media.assets
           SET authoritative_object_key = $2,
               authoritative_object_version = $3,
               authoritative_object_checksum = decode($4, 'hex'),
               row_version = row_version + 1
           WHERE id = $1 AND capability_generation = 0 AND row_version = 0`,
            [assetId, outcome.objectKey, outcome.version, outcome.checksumHex],
          );
          assert.equal(committed.rowCount, 1);
          await winner.query('COMMIT');
        })();
        assert.equal(provider.putCalls, 1);

        await loser.query('BEGIN');
        await loser.query(`SET LOCAL statement_timeout = '75ms'`);
        const losingResult = await loser
          .query(
            `INSERT INTO media.gateway_upload_leases(
           asset_id, capability_generation, lease_id, starting_asset_row_version,
           inbound_deadline_at, state, staging_object_key, temp_manifest_id
         ) VALUES (
           $1, 0, '7a000000-0000-4000-8000-000000000005', 0,
           clock_timestamp() + interval '1 minute', 'receiving',
           'private/provider-race/loser', '7a000000-0000-4000-8000-000000000006'
         )
         ON CONFLICT (asset_id, capability_generation) DO NOTHING`,
            [assetId],
          )
          .then(
            () => undefined,
            (error: unknown) => error as { code?: string; message?: string },
          );
        await loser.query('ROLLBACK');
        await winnerCompletion;

        assert.equal(losingResult?.code, '57014');
        assert.match(losingResult?.message ?? '', /statement timeout/u);
        assert.equal(provider.putCalls, 1);
        const durable = await client.query<{
          lease_count: string;
          state: string;
          staging_object_key: string;
          authoritative_object_key: string;
          authoritative_object_version: string;
        }>(
          `SELECT count(*) OVER ()::text AS lease_count,
                lease.state,
                lease.staging_object_key,
                asset.authoritative_object_key,
                asset.authoritative_object_version
         FROM media.gateway_upload_leases lease
         JOIN media.assets asset ON asset.id = lease.asset_id
         WHERE lease.asset_id = $1`,
          [assetId],
        );
        assert.deepEqual(durable.rows, [
          {
            lease_count: '1',
            state: 'committed',
            staging_object_key: 'private/provider-race/winner',
            authoritative_object_key: 'private/provider-race/winner',
            authoritative_object_version: 'provider-race-version',
          },
        ]);
      } finally {
        await Promise.all([
          winner.query('ROLLBACK').catch(() => undefined),
          loser.query('ROLLBACK').catch(() => undefined),
        ]);
        await Promise.all([winner.end(), loser.end()]);
      }
    });
  },
);

void postgresTest(
  'blocks account-merge collisions and atomically transfers collision-free media ownership',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);

      const attemptSource = 'b0000000-0000-4000-8000-000000000001';
      const attemptTarget = 'b0000000-0000-4000-8000-000000000002';
      const collidingAttempt = 'b1000000-0000-4000-8000-000000000001';
      await insertUser(client, attemptSource, 'merge_attempt_source');
      await insertUser(client, attemptTarget, 'merge_attempt_target');
      const sourceAttemptAsset = await claimUploadAttempt(client, {
        ownerId: attemptSource,
        attemptId: collidingAttempt,
        intentHashHex: '51'.repeat(32),
      });
      const targetAttemptAsset = await claimUploadAttempt(client, {
        ownerId: attemptTarget,
        attemptId: collidingAttempt,
        intentHashHex: '52'.repeat(32),
      });
      assert.ok(sourceAttemptAsset);
      assert.ok(targetAttemptAsset);
      const attemptJob = 'b2000000-0000-4000-8000-000000000001';
      await client.query(
        `INSERT INTO identity.account_merge_jobs(
         id, source_user_id, target_user_id, preview_json, expires_at
       ) VALUES ($1, $2, $3, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
        [attemptJob, attemptSource, attemptTarget],
      );
      assert.equal(
        (
          await client.query<{ outcome: string }>(
            'SELECT media.apply_account_merge($1) AS outcome',
            [attemptJob],
          )
        ).rows[0]?.outcome,
        'blocked_media_collision',
      );
      const blockedAttempt = await client.query<{
        state: string;
        failure_code: string;
        media_collision_json: { kind: string; keyHash: string };
      }>(
        `SELECT state, failure_code, media_collision_json
       FROM identity.account_merge_jobs WHERE id = $1`,
        [attemptJob],
      );
      assert.equal(blockedAttempt.rows[0]?.state, 'failed');
      assert.equal(blockedAttempt.rows[0]?.failure_code, 'blocked_media_collision');
      assert.equal(blockedAttempt.rows[0]?.media_collision_json.kind, 'upload_attempt');
      assert.match(blockedAttempt.rows[0]?.media_collision_json.keyHash ?? '', /^[a-f0-9]{64}$/u);
      assert.equal(
        (
          await client.query<{ count: string }>(
            'SELECT count(*) FROM media.assets WHERE current_owner_id = $1',
            [attemptSource],
          )
        ).rows[0]?.count,
        '1',
      );

      const receiptCollisionScenarios = [
        { operation: 'event_attachment' as const, ordinal: 2 },
        { operation: 'event_arrangement' as const, ordinal: 3 },
        { operation: 'report_submission' as const, ordinal: 4 },
      ];
      for (const scenario of receiptCollisionScenarios) {
        const suffix = String(scenario.ordinal).padStart(12, '0');
        const source = `b3000000-0000-4000-8000-${suffix}`;
        const target = `b4000000-0000-4000-8000-${suffix}`;
        const key = `b5000000-0000-4000-8000-${suffix}`;
        const resource = `b6000000-0000-4000-8000-${suffix}`;
        const job = `b7000000-0000-4000-8000-${suffix}`;
        await insertUser(client, source, `merge_receipt_source_${scenario.ordinal}`);
        await insertUser(client, target, `merge_receipt_target_${scenario.ordinal}`);
        if (scenario.operation === 'report_submission') {
          await insertReportReceipt(client, {
            ownerId: source,
            targetUserId: target,
            idempotencyKey: key,
            ordinal: 40,
          });
          await insertReportReceipt(client, {
            ownerId: target,
            targetUserId: source,
            idempotencyKey: key,
            ordinal: 41,
          });
        } else {
          await insertMutationReceipt(client, {
            ownerId: source,
            operationType: scenario.operation,
            idempotencyKey: key,
            resourceId: resource,
          });
          await insertMutationReceipt(client, {
            ownerId: target,
            operationType: scenario.operation,
            idempotencyKey: key,
            resourceId: resource,
          });
        }
        await client.query(
          `INSERT INTO identity.account_merge_jobs(
           id, source_user_id, target_user_id, preview_json, expires_at
         ) VALUES ($1, $2, $3, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
          [job, source, target],
        );
        const outcome = await client.query<{ outcome: string }>(
          'SELECT media.apply_account_merge($1) AS outcome',
          [job],
        );
        assert.equal(outcome.rows[0]?.outcome, 'blocked_media_collision');
        const blocked = await client.query<{
          failure_code: string;
          collision_kind: string;
          source_receipts: string;
        }>(
          `SELECT job.failure_code,
                job.media_collision_json->>'kind' AS collision_kind,
                (SELECT count(*)::text FROM media.mutation_receipts
                 WHERE current_owner_id = $2) AS source_receipts
         FROM identity.account_merge_jobs job WHERE job.id = $1`,
          [job, source],
        );
        assert.deepEqual(blocked.rows[0], {
          failure_code: 'blocked_media_collision',
          collision_kind: 'mutation_receipt',
          source_receipts: '1',
        });
      }

      const source = 'c0000000-0000-4000-8000-000000000001';
      const target = 'c0000000-0000-4000-8000-000000000002';
      const attempt = 'c1000000-0000-4000-8000-000000000001';
      const receiptKey = 'c2000000-0000-4000-8000-000000000001';
      const resource = 'c3000000-0000-4000-8000-000000000001';
      const mergeJob = 'c4000000-0000-4000-8000-000000000001';
      await insertUser(client, source, 'merge_clean_source');
      await insertUser(client, target, 'merge_clean_target');
      const sourceAsset = await claimUploadAttempt(client, {
        ownerId: source,
        attemptId: attempt,
        intentHashHex: '61'.repeat(32),
      });
      assert.ok(sourceAsset);
      await client.query(`UPDATE media.assets SET capability_generation = 2 WHERE id = $1`, [
        sourceAsset,
      ]);
      const sourceReceipt = await insertMutationReceipt(client, {
        ownerId: source,
        operationType: 'event_attachment',
        idempotencyKey: receiptKey,
        resourceId: resource,
      });
      await client.query(
        `INSERT INTO media.gateway_upload_leases(
         asset_id, capability_generation, lease_id, starting_asset_row_version,
         inbound_deadline_at, state, staging_object_key, temp_manifest_id
       ) VALUES (
         $1, 2, 'c5000000-0000-4000-8000-000000000001', 0,
         clock_timestamp() + interval '1 minute', 'receiving', 'private/merge/source',
         'c6000000-0000-4000-8000-000000000001'
       )`,
        [sourceAsset],
      );
      await client.query(
        `INSERT INTO sync.idempotency_keys(
         key, user_id, request_hash, response_code, response_body,
         resource_type, resource_id, expires_at
       ) VALUES (
         $1, $2, decode(repeat('61', 32), 'hex'), 201,
         jsonb_build_object('attemptId', $1::uuid, 'assetId', $3::uuid, 'state', 'pending_upload'),
         'media.upload_intent', $3, clock_timestamp() + interval '1 day'
       )`,
        [attempt, source, sourceAsset],
      );
      await client.query(
        `INSERT INTO identity.account_merge_jobs(
         id, source_user_id, target_user_id, preview_json, expires_at
       ) VALUES ($1, $2, $3, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
        [mergeJob, source, target],
      );

      const merged = await client.query<{ outcome: string }>(
        'SELECT media.apply_account_merge($1) AS outcome',
        [mergeJob],
      );
      assert.equal(merged.rows[0]?.outcome, 'committed');
      const transferredAsset = await client.query<{
        current_owner_id: string;
        created_owner_id: string;
        capability_generation: string;
        row_version: string;
      }>(
        'SELECT current_owner_id, created_owner_id, capability_generation, row_version FROM media.assets WHERE id = $1',
        [sourceAsset],
      );
      assert.deepEqual(transferredAsset.rows[0], {
        current_owner_id: target,
        created_owner_id: source,
        capability_generation: '3',
        row_version: '1',
      });
      const transferredReceipt = await client.query<{
        current_owner_id: string;
        created_owner_id: string;
      }>('SELECT current_owner_id, created_owner_id FROM media.mutation_receipts WHERE id = $1', [
        sourceReceipt,
      ]);
      assert.deepEqual(transferredReceipt.rows[0], {
        current_owner_id: target,
        created_owner_id: source,
      });
      const transferAuthorization = await client.query<{
        state: string;
        transferred_asset_count: number;
        transferred_receipt_count: number;
        committed_at: Date | null;
      }>(
        `SELECT state, transferred_asset_count, transferred_receipt_count, committed_at
       FROM media.account_merge_transfer_authorizations WHERE job_id = $1`,
        [mergeJob],
      );
      assert.deepEqual(
        transferAuthorization.rows.map((row) => ({
          ...row,
          committed_at: Boolean(row.committed_at),
        })),
        [
          {
            state: 'committed',
            transferred_asset_count: 1,
            transferred_receipt_count: 1,
            committed_at: true,
          },
        ],
      );
      await assert.rejects(
        client.query(
          `UPDATE media.mutation_receipts
         SET replay_response = '{"tampered":true}'::jsonb WHERE id = $1`,
          [sourceReceipt],
        ),
        /mutation receipt is immutable/u,
      );
      await assert.rejects(
        client.query('UPDATE media.mutation_receipts SET current_owner_id = $2 WHERE id = $1', [
          sourceReceipt,
          source,
        ]),
        /direct media receipt owner updates are forbidden/u,
      );
      assert.equal(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) FROM sync.idempotency_keys
           WHERE user_id = $1 AND resource_type LIKE 'media.%'`,
            [source],
          )
        ).rows[0]?.count,
        '0',
      );
      const recoveryByCurrentOwner = await client.query<{ id: string }>(
        `SELECT id FROM media.assets
       WHERE current_owner_id = $1 AND upload_attempt_id = $2`,
        [target, attempt],
      );
      assert.equal(recoveryByCurrentOwner.rows[0]?.id, sourceAsset);
      assert.equal(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) FROM media.assets
           WHERE current_owner_id = $1 AND upload_attempt_id = $2`,
            [source, attempt],
          )
        ).rows[0]?.count,
        '0',
      );
      assert.equal(
        (
          await client.query<{ count: string }>(
            'SELECT count(*) FROM media.assets WHERE created_owner_id = $1 AND id = $2',
            [source, sourceAsset],
          )
        ).rows[0]?.count,
        '1',
      );
      const leaseFence = await client.query<{
        capability_generation: string;
        current_generation: string;
      }>(
        `SELECT lease.capability_generation,
              asset.capability_generation AS current_generation
       FROM media.gateway_upload_leases lease
       JOIN media.assets asset ON asset.id = lease.asset_id
       WHERE lease.asset_id = $1`,
        [sourceAsset],
      );
      assert.deepEqual(leaseFence.rows[0], {
        capability_generation: '2',
        current_generation: '3',
      });
      const committedJob = await client.query<{ state: string; committed_at: Date | null }>(
        'SELECT state, committed_at FROM identity.account_merge_jobs WHERE id = $1',
        [mergeJob],
      );
      assert.equal(committedJob.rows[0]?.state, 'committed');
      assert.ok(committedJob.rows[0]?.committed_at);
      const auditCount = await client.query<{ count: string }>(
        `SELECT count(*) FROM admin.audit_logs
       WHERE resource_id IN ($1, $2, $3, $4, $5)
         AND action IN (
           'account_merge.blocked_media_collision',
           'account_merge.media_ownership_committed'
         )`,
        [
          attemptJob,
          mergeJob,
          ...receiptCollisionScenarios.map(
            (item) => `b7000000-0000-4000-8000-${String(item.ordinal).padStart(12, '0')}`,
          ),
        ],
      );
      assert.equal(auditCount.rows[0]?.count, '5');
    });
  },
);

void postgresTest(
  'keeps completion and mutation receipts for life with verified ordered report evidence',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const owner = 'd0000000-0000-4000-8000-000000000001';
      const target = 'd0000000-0000-4000-8000-000000000002';
      const attempt = 'd1000000-0000-4000-8000-000000000001';
      const completionAttempt = 'd2000000-0000-4000-8000-000000000001';
      await insertUser(client, owner, 'receipt_owner');
      await insertUser(client, target, 'receipt_target');
      const assetId = await claimUploadAttempt(client, {
        ownerId: owner,
        attemptId: attempt,
        intentHashHex: '71'.repeat(32),
        expectedHashHex: 'ab'.repeat(32),
      });
      assert.ok(assetId);
      const provider = new FaultInjectedProviderAdapter();
      await commitGatewayLeaseThroughProvider(client, provider, {
        assetId,
        generation: 0,
        leaseId: 'd1000000-0000-4000-8000-000000000010',
        startingRowVersion: 0,
        objectKey: 'private/receipt-lifetime/winner',
        version: 'receipt-lifetime-version',
        checksumHex: 'ab'.repeat(32),
        manifestId: 'd1000000-0000-4000-8000-000000000011',
      });
      await client.query(
        `UPDATE media.assets
         SET state = 'uploaded', content_hash = expected_content_hash,
             uploaded_at = clock_timestamp(), row_version = row_version + 1
         WHERE id = $1 AND state = 'pending_upload' AND row_version = 1`,
        [assetId],
      );
      const outboxEventId = 'd3000000-0000-4000-8000-000000000001';
      await client.query(
        `INSERT INTO sync.outbox_events(
         event_id, aggregate, aggregate_id, type, payload, published_at
       ) VALUES (
         $1, 'media.asset', $2, 'media.processing_requested',
         jsonb_build_object('assetId', $2::uuid), clock_timestamp()
       )`,
        [outboxEventId, assetId],
      );
      await client.query(
        `INSERT INTO media.completion_receipts(
         asset_id, completion_attempt_id, request_fingerprint,
         verified_content_hash, replay_response, outbox_event_id
       ) VALUES (
         $1, $2, decode(repeat('72', 32), 'hex'), decode(repeat('ab', 32), 'hex'),
         jsonb_build_object('assetId', $1::uuid, 'state', 'uploaded'), $3
       )`,
        [assetId, completionAttempt, outboxEventId],
      );
      await assert.rejects(
        client.query(
          `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('media.asset', $1, 'media.processing_requested', '{}'::jsonb)`,
          [assetId],
        ),
        /uq_sync_outbox_media_processing_lifetime/u,
      );
      await assert.rejects(
        client.query(
          `UPDATE media.completion_receipts
         SET replay_response = '{"tampered":true}'::jsonb WHERE asset_id = $1`,
          [assetId],
        ),
        /completion_receipts is append-only/u,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media.mutation_receipts(
           current_owner_id, created_owner_id, operation_type, idempotency_key,
           request_fingerprint, canonical_request, replay_response,
           resource_type, resource_id, resource_version
         ) VALUES (
           $1, $1, 'event_attachment',
           'd4000000-0000-4000-8000-000000000099',
           decode(repeat('73', 32), 'hex'), '{}'::jsonb,
           '{"assetId":"safe-looking","uploadUrl":"https://gateway.invalid/secret"}'::jsonb,
           'event', 'd5000000-0000-4000-8000-000000000099', 1
         )`,
          [owner],
        ),
        /mutation_receipts_safe_replay_check/u,
      );

      const receiptId = await insertReportReceipt(client, {
        ownerId: owner,
        targetUserId: target,
        idempotencyKey: 'd4000000-0000-4000-8000-000000000001',
        ordinal: 70,
      });
      await assert.rejects(
        client.query(
          `INSERT INTO media.report_receipt_evidence(
           receipt_id, sort_order, asset_id, verified_content_hash
         ) VALUES ($1, 0, $2, decode(repeat('cd', 32), 'hex'))`,
          [receiptId, assetId],
        ),
        /report_receipt_evidence_verified_content_fkey/u,
      );
      await client.query(
        `INSERT INTO media.report_receipt_evidence(
         receipt_id, sort_order, asset_id, verified_content_hash
       ) VALUES ($1, 0, $2, decode(repeat('ab', 32), 'hex'))`,
        [receiptId, assetId],
      );
      const durable = await client.query<{
        idempotency_key: string;
        sort_order: number;
        asset_id: string;
        verified_hash: string;
      }>(
        `SELECT receipt.idempotency_key,
              evidence.sort_order,
              evidence.asset_id,
              encode(evidence.verified_content_hash, 'hex') AS verified_hash
       FROM media.mutation_receipts receipt
       JOIN media.report_receipt_evidence evidence ON evidence.receipt_id = receipt.id
       WHERE receipt.id = $1`,
        [receiptId],
      );
      assert.deepEqual(durable.rows, [
        {
          idempotency_key: 'd4000000-0000-4000-8000-000000000001',
          sort_order: 0,
          asset_id: assetId,
          verified_hash: 'ab'.repeat(32),
        },
      ]);
    });
  },
);

void postgresTest('keeps every legacy-null upload binding permanently null', async () => {
  await withOwnedDatabase(async (client) => {
    await applyMigrations(client, 21);
    const ownerId = 'e1000000-0000-4000-8000-000000000001';
    const assetId = 'e1000000-0000-4000-8000-000000000002';
    await insertUser(client, ownerId, 'legacy_null_binding_owner');
    await client.query(
      `INSERT INTO media.assets(
         id, owner_id, purpose, object_key, original_filename, mime_type, byte_size
       ) VALUES ($1, $2, 'event_cover', 'legacy/pending/null-binding', 'legacy.jpg',
                 'image/jpeg', 16)`,
      [assetId, ownerId],
    );
    await applyMigrations(client);

    await assert.rejects(
      client.query(
        `UPDATE media.assets
         SET upload_attempt_id = 'e1000000-0000-4000-8000-000000000003',
             intent_request_hash = decode(repeat('11', 32), 'hex'),
             expected_content_hash = decode(repeat('aa', 32), 'hex')
         WHERE id = $1`,
        [assetId],
      ),
      /upload attempt binding is immutable/u,
    );
    const binding = await client.query<{
      upload_attempt_id: string | null;
      intent_request_hash: Buffer | null;
      expected_content_hash: Buffer | null;
    }>(
      `SELECT upload_attempt_id, intent_request_hash, expected_content_hash
       FROM media.assets WHERE id = $1`,
      [assetId],
    );
    assert.deepEqual(binding.rows, [
      {
        upload_attempt_id: null,
        intent_request_hash: null,
        expected_content_hash: null,
      },
    ]);
  });
});

void postgresTest('requires a gateway lease to start in receiving state', async () => {
  await withOwnedDatabase(async (client) => {
    await applyMigrations(client);
    const ownerId = 'e2000000-0000-4000-8000-000000000001';
    await insertUser(client, ownerId, 'direct_committed_lease_owner');
    const assetId = await claimUploadAttempt(client, {
      ownerId,
      attemptId: 'e2000000-0000-4000-8000-000000000002',
      intentHashHex: '12'.repeat(32),
      expectedHashHex: 'aa'.repeat(32),
    });
    assert.ok(assetId);

    await assert.rejects(
      client.query(
        `INSERT INTO media.gateway_upload_leases(
           asset_id, capability_generation, lease_id, starting_asset_row_version,
           inbound_deadline_at, provider_deadline_at, state, staging_object_key,
           provider_object_version, provider_object_checksum, temp_manifest_id, committed_at
         ) VALUES (
           $1, 0, 'e2000000-0000-4000-8000-000000000003', 0,
           clock_timestamp() + interval '1 minute', clock_timestamp() + interval '2 minutes',
           'committed', 'private/direct-committed', 'forged-version',
           decode(repeat('aa', 32), 'hex'),
           'e2000000-0000-4000-8000-000000000004', clock_timestamp()
         )`,
        [assetId],
      ),
      /gateway lease must start in receiving state/u,
    );
  });
});

void postgresTest(
  'requires the committed provider checksum to match the expected content hash',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'e3000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerId, 'checksum_binding_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'e3000000-0000-4000-8000-000000000002',
        intentHashHex: '13'.repeat(32),
        expectedHashHex: 'aa'.repeat(32),
      });
      assert.ok(assetId);
      await client.query(
        `INSERT INTO media.gateway_upload_leases(
         asset_id, capability_generation, lease_id, starting_asset_row_version,
         inbound_deadline_at, state, staging_object_key, temp_manifest_id
       ) VALUES (
         $1, 0, 'e3000000-0000-4000-8000-000000000003', 0,
         clock_timestamp() + interval '1 minute', 'receiving', 'private/checksum-mismatch',
         'e3000000-0000-4000-8000-000000000004'
       )`,
        [assetId],
      );
      await client.query(
        `UPDATE media.gateway_upload_leases
       SET state = 'provider_writing', provider_deadline_at = clock_timestamp() + interval '1 minute'
       WHERE asset_id = $1 AND capability_generation = 0`,
        [assetId],
      );
      await assert.rejects(
        client.query(
          `UPDATE media.gateway_upload_leases
         SET state = 'committed', provider_object_version = 'provider-version-bb',
             provider_object_checksum = decode(repeat('bb', 32), 'hex'),
             committed_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = 0`,
          [assetId],
        ),
        /provider checksum must match expected content hash/u,
      );
    });
  },
);

void postgresTest('binds gateway cleanup to the exact failed lease key and version', async () => {
  await withOwnedDatabase(async (client) => {
    await applyMigrations(client);
    const ownerId = 'e4000000-0000-4000-8000-000000000001';
    await insertUser(client, ownerId, 'cleanup_binding_owner');
    const assetId = await claimUploadAttempt(client, {
      ownerId,
      attemptId: 'e4000000-0000-4000-8000-000000000002',
      intentHashHex: '14'.repeat(32),
      expectedHashHex: 'aa'.repeat(32),
    });
    assert.ok(assetId);
    const leaseId = 'e4000000-0000-4000-8000-000000000003';
    const stagingKey = 'private/cleanup-authoritative';
    const version = 'authoritative-version';
    await client.query(
      `INSERT INTO media.gateway_upload_leases(
         asset_id, capability_generation, lease_id, starting_asset_row_version,
         inbound_deadline_at, state, staging_object_key, temp_manifest_id
       ) VALUES (
         $1, 0, $2, 0, clock_timestamp() + interval '1 minute', 'receiving', $3,
         'e4000000-0000-4000-8000-000000000004'
       )`,
      [assetId, leaseId, stagingKey],
    );
    await client.query(
      `UPDATE media.gateway_upload_leases
       SET state = 'provider_writing', provider_deadline_at = clock_timestamp() + interval '1 minute'
       WHERE asset_id = $1 AND capability_generation = 0`,
      [assetId],
    );
    await client.query(
      `UPDATE media.gateway_upload_leases
       SET state = 'committed', provider_object_version = $2,
           provider_object_checksum = decode(repeat('aa', 32), 'hex'),
           committed_at = clock_timestamp()
       WHERE asset_id = $1 AND capability_generation = 0`,
      [assetId, version],
    );
    await client.query(
      `UPDATE media.assets
       SET authoritative_object_key = $2, authoritative_object_version = $3,
           authoritative_object_checksum = decode(repeat('aa', 32), 'hex'),
           row_version = row_version + 1
       WHERE id = $1`,
      [assetId, stagingKey, version],
    );

    await assert.rejects(
      client.query(
        `INSERT INTO media.object_cleanup_tasks(
           asset_id, object_kind, object_key, object_version,
           capability_generation, lease_id, cleanup_not_before
         ) VALUES (
           $1, 'gateway_staging', $2, NULL, 999,
           'e4000000-0000-4000-8000-000000000099', clock_timestamp()
         )`,
        [assetId, stagingKey],
      ),
      /losing cleanup cannot target the authoritative object/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO media.object_cleanup_tasks(
           asset_id, object_kind, object_key, object_version,
           capability_generation, lease_id, cleanup_not_before
         ) VALUES (
           $1, 'gateway_staging', 'private/unbound-cleanup', NULL, 999,
           'e4000000-0000-4000-8000-000000000099', clock_timestamp()
         )`,
        [assetId],
      ),
      /gateway cleanup must match an exact failed lease identity/u,
    );
  });
});

void postgresTest(
  'keeps cleanup ledger rows append-only after a valid failed lease binding',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'e5000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerId, 'cleanup_append_only_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'e5000000-0000-4000-8000-000000000002',
        intentHashHex: '15'.repeat(32),
        expectedHashHex: 'aa'.repeat(32),
      });
      assert.ok(assetId);
      const leaseId = 'e5000000-0000-4000-8000-000000000003';
      const cleanupId = 'e5000000-0000-4000-8000-000000000005';
      await client.query(
        `INSERT INTO media.gateway_upload_leases(
         asset_id, capability_generation, lease_id, starting_asset_row_version,
         inbound_deadline_at, state, staging_object_key, temp_manifest_id
       ) VALUES (
         $1, 0, $2, 0, clock_timestamp() + interval '1 minute', 'receiving',
         'private/failed-cleanup', 'e5000000-0000-4000-8000-000000000004'
       )`,
        [assetId, leaseId],
      );
      await client.query(
        `UPDATE media.gateway_upload_leases
       SET state = 'provider_writing', provider_deadline_at = clock_timestamp() + interval '1 minute'
       WHERE asset_id = $1 AND capability_generation = 0`,
        [assetId],
      );
      await client.query(
        `UPDATE media.gateway_upload_leases
       SET state = 'failed_cleanup_pending', failed_at = clock_timestamp(),
           provider_abort_confirmed_at = clock_timestamp()
       WHERE asset_id = $1 AND capability_generation = 0`,
        [assetId],
      );
      await client.query(
        `INSERT INTO media.object_cleanup_tasks(
         id, asset_id, object_kind, object_key, object_version,
         capability_generation, lease_id, cleanup_not_before
       ) VALUES ($1, $2, 'gateway_staging', 'private/failed-cleanup', NULL, 0, $3,
                 media.cleanup_fence_for_asset($2))`,
        [cleanupId, assetId, leaseId],
      );

      await assert.rejects(
        client.query('DELETE FROM media.object_cleanup_tasks WHERE id = $1', [cleanupId]),
        /cleanup ledger is append-only/u,
      );
      const durable = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM media.object_cleanup_tasks WHERE id = $1',
        [cleanupId],
      );
      assert.equal(durable.rows[0]?.count, '1');
    });
  },
);

void postgresTest(
  'rejects caller-spoofed account-merge authorization on direct owner updates',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const sourceId = 'e6000000-0000-4000-8000-000000000001';
      const targetId = 'e6000000-0000-4000-8000-000000000002';
      const mergeJobId = 'e6000000-0000-4000-8000-000000000003';
      await insertUser(client, sourceId, 'spoofed_merge_source');
      await insertUser(client, targetId, 'spoofed_merge_target');
      const assetId = await claimUploadAttempt(client, {
        ownerId: sourceId,
        attemptId: 'e6000000-0000-4000-8000-000000000004',
        intentHashHex: '16'.repeat(32),
        expectedHashHex: 'aa'.repeat(32),
      });
      assert.ok(assetId);
      await client.query(
        `INSERT INTO identity.account_merge_jobs(
         id, source_user_id, target_user_id, preview_json, expires_at
       ) VALUES ($1, $2, $3, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
        [mergeJobId, sourceId, targetId],
      );

      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL spott.media_account_merge_job = '${mergeJobId}'`);
        await assert.rejects(
          client.query('UPDATE media.assets SET current_owner_id = $2 WHERE id = $1', [
            assetId,
            targetId,
          ]),
          /direct media owner updates are forbidden/u,
        );
      } finally {
        await client.query('ROLLBACK');
      }
      const unchanged = await client.query<{
        current_owner_id: string;
        capability_generation: string;
        row_version: string;
      }>(
        `SELECT current_owner_id, capability_generation, row_version
       FROM media.assets WHERE id = $1`,
        [assetId],
      );
      assert.deepEqual(unchanged.rows, [
        {
          current_owner_id: sourceId,
          capability_generation: '0',
          row_version: '0',
        },
      ]);
    });
  },
);

void postgresTest(
  'revokes default PUBLIC execution from the media owner-transfer boundary',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const privileges = await client.query<{ public_execute: boolean }>(
        `SELECT EXISTS (
         SELECT 1
         FROM pg_proc function_record
         CROSS JOIN LATERAL aclexplode(
           COALESCE(function_record.proacl, acldefault('f', function_record.proowner))
         ) privilege
         WHERE function_record.oid = 'media.apply_account_merge(uuid)'::regprocedure
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       ) AS public_execute`,
      );
      assert.deepEqual(privileges.rows, [{ public_execute: false }]);
    });
  },
);

void postgresTest(
  'rejects credential-shaped replay values even when their keys look harmless',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const result = await client.query<{ safe: boolean }>(
        `SELECT media.safe_replay_json(value) AS safe
       FROM jsonb_array_elements($1::jsonb) AS replay(value)`,
        [
          JSON.stringify([
            { location: 'https://storage.invalid/upload?X-Amz-Signature=secret' },
            { note: 'Bearer leaked-access-token' },
            { reference: 'private/uploads/provider-object-key' },
          ]),
        ],
      );
      assert.deepEqual(result.rows, [{ safe: false }, { safe: false }, { safe: false }]);
    });
  },
);

void postgresTest(
  'enforces exact media replay stub fields for generic idempotency rows',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'e7000000-0000-4000-8000-000000000001';
      const resourceId = 'e7000000-0000-4000-8000-000000000002';
      await insertUser(client, ownerId, 'unsafe_generic_replay_owner');

      await assert.rejects(
        client.query(
          `INSERT INTO sync.idempotency_keys(
           key, user_id, request_hash, response_code, response_body,
           resource_type, resource_id, expires_at
         ) VALUES (
           'e7000000-0000-4000-8000-000000000003', $1,
           decode(repeat('17', 32), 'hex'), 201,
           jsonb_build_object(
             'resourceType', 'media.asset',
             'resourceId', $2::uuid,
             'state', 'pending_upload',
             'debugLabel', 'safe-looking-but-not-an-api-field'
           ),
           'media.upload_intent', $2, clock_timestamp() + interval '1 day'
         )`,
          [ownerId, resourceId],
        ),
        /idempotency_keys_media_safe_replay_check/u,
      );
    });
  },
);

void postgresTest(
  'enforces operation-specific replay fields for durable media receipts',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'e8000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerId, 'unsafe_receipt_replay_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'e8000000-0000-4000-8000-000000000002',
        intentHashHex: '18'.repeat(32),
        expectedHashHex: 'aa'.repeat(32),
      });
      assert.ok(assetId);

      await assert.rejects(
        client.query(
          `INSERT INTO media.completion_receipts(asset_id, replay_response, legacy_backfilled)
         VALUES ($1, jsonb_build_object(
           'assetId', $1::uuid,
           'state', 'uploaded',
           'debugLabel', 'safe-looking-but-not-an-api-field'
         ), true)`,
          [assetId],
        ),
        /completion_receipts_safe_replay_check/u,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media.mutation_receipts(
           current_owner_id, created_owner_id, operation_type, idempotency_key,
           request_fingerprint, canonical_request, replay_response,
           resource_type, resource_id, resource_version
         ) VALUES (
           $1, $1, 'event_attachment',
           'e8000000-0000-4000-8000-000000000003',
           decode(repeat('19', 32), 'hex'), '{}'::jsonb,
           jsonb_build_object(
             'resourceId', 'e8000000-0000-4000-8000-000000000004'::uuid,
             'version', 1,
             'debugLabel', 'safe-looking-but-not-an-api-field'
           ),
           'event', 'e8000000-0000-4000-8000-000000000004', 1
         )`,
          [ownerId],
        ),
        /mutation_receipts_safe_replay_check/u,
      );
    });
  },
);

void postgresTest(
  'deterministically quarantines duplicate valid legacy report evidence',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client, 21);
      const ownerId = 'e9000000-0000-4000-8000-000000000001';
      const assetId = 'e9000000-0000-4000-8000-000000000002';
      const reportId = 'e9000000-0000-4000-8000-000000000003';
      const winnerId = 'e9000000-0000-4000-8000-000000000004';
      const duplicateId = 'e9000000-0000-4000-8000-000000000005';
      await insertUser(client, ownerId, 'duplicate_evidence_owner');
      await client.query(
        `INSERT INTO media.assets(
         id, owner_id, purpose, object_key, original_filename, mime_type,
         byte_size, content_hash, state, uploaded_at, ready_at
       ) VALUES (
         $1, $2, 'report_evidence', 'legacy/evidence/duplicate', 'evidence.jpg',
         'image/jpeg', 16, decode(repeat('aa', 32), 'hex'), 'ready',
         clock_timestamp(), clock_timestamp()
       )`,
        [assetId, ownerId],
      );
      await client.query(
        `INSERT INTO safety.reports(
         id, public_reference, reporter_id, target_type, target_id, reason, severity
       ) VALUES ($1, 'SPOTT-DUP-EVIDENCE', $2, 'user', $2, 'duplicate fixture', 'p2')`,
        [reportId, ownerId],
      );
      await client.query(
        `INSERT INTO safety.evidence_assets(
         id, report_id, asset_id, kms_key_ref, content_hash, retention_until, created_at
       ) VALUES
       ($1, $3, $4, 'kms/legacy', decode(repeat('aa', 32), 'hex'),
        clock_timestamp() + interval '30 days', clock_timestamp() - interval '2 minutes'),
       ($2, $3, $4, 'kms/legacy', decode(repeat('aa', 32), 'hex'),
        clock_timestamp() + interval '30 days', clock_timestamp() - interval '1 minute')`,
        [winnerId, duplicateId, reportId, assetId],
      );

      await applyMigrations(client);

      const survivor = await client.query<{ id: string; sort_order: number }>(
        'SELECT id, sort_order FROM safety.evidence_assets WHERE report_id = $1',
        [reportId],
      );
      assert.deepEqual(survivor.rows, [{ id: winnerId, sort_order: 0 }]);
      const quarantined = await client.query<{
        evidence_id: string;
        reason: string;
        survivor_evidence_id: string;
      }>(
        `SELECT evidence_id, reason, survivor_evidence_id
       FROM safety.evidence_asset_quarantine WHERE report_id = $1`,
        [reportId],
      );
      assert.deepEqual(quarantined.rows, [
        {
          evidence_id: duplicateId,
          reason: 'duplicate_report_asset',
          survivor_evidence_id: winnerId,
        },
      ]);
    });
  },
);

void postgresTest(
  'quarantines and clears invalid legacy media content hashes during upgrade',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client, 21);
      const ownerId = 'ea000000-0000-4000-8000-000000000001';
      const assetId = 'ea000000-0000-4000-8000-000000000002';
      await insertUser(client, ownerId, 'invalid_hash_upgrade_owner');
      await client.query(
        `INSERT INTO media.assets(
         id, owner_id, purpose, object_key, original_filename, mime_type,
         byte_size, content_hash, state
       ) VALUES (
         $1, $2, 'event_cover', 'legacy/invalid-content-hash', 'legacy.jpg',
         'image/jpeg', 16, decode('aa', 'hex'), 'pending_upload'
       )`,
        [assetId, ownerId],
      );

      await applyMigrations(client);

      const asset = await client.query<{ content_hash: Buffer | null }>(
        'SELECT content_hash FROM media.assets WHERE id = $1',
        [assetId],
      );
      assert.equal(asset.rows[0]?.content_hash, null);
      const audit = await client.query<{
        asset_id: string;
        original_content_hash: Buffer;
        reason: string;
      }>(
        `SELECT asset_id, original_content_hash, reason
       FROM media.legacy_asset_content_hash_quarantine WHERE asset_id = $1`,
        [assetId],
      );
      assert.equal(audit.rows[0]?.asset_id, assetId);
      assert.equal(audit.rows[0]?.original_content_hash.toString('hex'), 'aa');
      assert.equal(audit.rows[0]?.reason, 'invalid_content_hash_length');
    });
  },
);

void postgresTest(
  'rejects every future non-null media content hash that is not exactly 32 bytes',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'eb000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerId, 'invalid_hash_write_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'eb000000-0000-4000-8000-000000000002',
        intentHashHex: '1a'.repeat(32),
        expectedHashHex: 'aa'.repeat(32),
      });
      assert.ok(assetId);

      await assert.rejects(
        client.query(`UPDATE media.assets SET content_hash = decode('aa', 'hex') WHERE id = $1`, [
          assetId,
        ]),
        /assets_content_hash_check/u,
      );
    });
  },
);

void postgresTest(
  'binds historical worker cleanup to its durable lease instead of the asset current lease',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'ec000000-0000-4000-8000-000000000001';
      const firstLeaseId = 'ec000000-0000-4000-8000-000000000002';
      const currentLeaseId = 'ec000000-0000-4000-8000-000000000003';
      await insertUser(client, ownerId, 'worker_cleanup_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'ec000000-0000-4000-8000-000000000004',
        intentHashHex: '1b'.repeat(32),
      });
      assert.ok(assetId);

      await client.query(
        `UPDATE media.assets
         SET processing_generation = 1, processing_lease_id = $2,
             processing_lease_expires_at = clock_timestamp() + interval '4 minutes'
         WHERE id = $1`,
        [assetId, firstLeaseId],
      );
      await client.query(
        `INSERT INTO media.worker_processing_leases(
           asset_id, processing_generation, lease_id, lease_expires_at,
           staging_object_key, staging_object_version, provider_deadline_at, state
         ) VALUES (
           $1, 1, $2,
           (SELECT processing_lease_expires_at FROM media.assets WHERE id = $1),
           'private/worker/g1/derivative', 'worker-version-g1',
           clock_timestamp() + interval '3 minutes', 'processing'
         )`,
        [assetId, firstLeaseId],
      );
      await client.query(
        `UPDATE media.worker_processing_leases
         SET state = 'failed_cleanup_pending',
             provider_abort_confirmed_at = clock_timestamp(),
             failed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE asset_id = $1 AND processing_generation = 1`,
        [assetId],
      );
      await client.query(
        `UPDATE media.assets
         SET processing_generation = 2, processing_lease_id = $2,
             processing_lease_expires_at = clock_timestamp() + interval '6 minutes'
         WHERE id = $1`,
        [assetId, currentLeaseId],
      );

      await client.query(
        `INSERT INTO media.object_cleanup_tasks(
           asset_id, object_kind, object_key, object_version,
           processing_generation, lease_id, cleanup_not_before
         ) VALUES ($1, 'worker_staging', 'private/worker/g1/derivative',
                   'worker-version-g1', 1, $2, media.cleanup_fence_for_asset($1))`,
        [assetId, firstLeaseId],
      );

      const cleanup = await client.query<{
        processing_generation: string;
        lease_id: string;
      }>(
        `SELECT processing_generation, lease_id
         FROM media.object_cleanup_tasks
         WHERE asset_id = $1 AND object_kind = 'worker_staging'`,
        [assetId],
      );
      assert.deepEqual(cleanup.rows, [{ processing_generation: '1', lease_id: firstLeaseId }]);
    });
  },
);

void postgresTest(
  'fails cleanup closed without provider abort proof and enforces the exact greatest DB fence',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'ed000000-0000-4000-8000-000000000001';
      const leaseId = 'ed000000-0000-4000-8000-000000000002';
      await insertUser(client, ownerId, 'greatest_cleanup_fence_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'ed000000-0000-4000-8000-000000000003',
        intentHashHex: '1c'.repeat(32),
      });
      assert.ok(assetId);
      await client.query(
        `UPDATE media.assets
         SET latest_authorization_expires_at = clock_timestamp() + interval '7 minutes',
             processing_lease_id = 'ed000000-0000-4000-8000-000000000004',
             processing_lease_expires_at = clock_timestamp() + interval '9 minutes'
         WHERE id = $1`,
        [assetId],
      );
      await client.query(
        `INSERT INTO media.gateway_upload_leases(
           asset_id, capability_generation, lease_id, starting_asset_row_version,
           inbound_deadline_at, state, staging_object_key, temp_manifest_id
         ) VALUES (
           $1, 0, $2, 0, clock_timestamp() + interval '3 minutes', 'receiving',
           'private/greatest-fence/g0', 'ed000000-0000-4000-8000-000000000005'
         )`,
        [assetId, leaseId],
      );
      await client.query(
        `UPDATE media.gateway_upload_leases
         SET state = 'provider_writing',
             provider_deadline_at = clock_timestamp() + interval '5 minutes'
         WHERE asset_id = $1 AND capability_generation = 0`,
        [assetId],
      );
      await client.query(
        `UPDATE media.gateway_upload_leases
         SET state = 'failed_cleanup_pending', failed_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = 0`,
        [assetId],
      );

      await assert.rejects(
        client.query(
          `INSERT INTO media.object_cleanup_tasks(
             asset_id, object_kind, object_key, capability_generation,
             lease_id, cleanup_not_before
           ) VALUES ($1, 'gateway_staging', 'private/greatest-fence/g0', 0, $2,
                     clock_timestamp() + interval '1 day')`,
          [assetId, leaseId],
        ),
        /provider abort confirmation is required/u,
      );

      await client.query(
        `UPDATE media.gateway_upload_leases
         SET provider_abort_confirmed_at = clock_timestamp()
         WHERE asset_id = $1 AND capability_generation = 0`,
        [assetId],
      );
      const fence = await client.query<{ fence: Date | null }>(
        'SELECT media.cleanup_fence_for_asset($1) AS fence',
        [assetId],
      );
      assert.ok(fence.rows[0]?.fence);
      await assert.rejects(
        client.query(
          `INSERT INTO media.object_cleanup_tasks(
             asset_id, object_kind, object_key, capability_generation,
             lease_id, cleanup_not_before
           ) VALUES ($1, 'gateway_staging', 'private/greatest-fence/g0', 0, $2,
                     media.cleanup_fence_for_asset($1) - interval '1 microsecond')`,
          [assetId, leaseId],
        ),
        /cleanup fence precedes the greatest persisted write fence/u,
      );
      await client.query(
        `INSERT INTO media.object_cleanup_tasks(
           asset_id, object_kind, object_key, capability_generation,
           lease_id, cleanup_not_before
         ) VALUES ($1, 'gateway_staging', 'private/greatest-fence/g0', 0, $2,
                   media.cleanup_fence_for_asset($1))`,
        [assetId, leaseId],
      );
    });
  },
);

void postgresTest(
  'rejects forged pending content hashes until a committed provider receipt anchors the digest',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const ownerId = 'ee000000-0000-4000-8000-000000000001';
      await insertUser(client, ownerId, 'pending_hash_fence_owner');
      const assetId = await claimUploadAttempt(client, {
        ownerId,
        attemptId: 'ee000000-0000-4000-8000-000000000002',
        intentHashHex: '1d'.repeat(32),
        expectedHashHex: 'ab'.repeat(32),
      });
      assert.ok(assetId);

      await assert.rejects(
        client.query(
          `UPDATE media.assets
           SET content_hash = expected_content_hash
           WHERE id = $1 AND state = 'pending_upload'`,
          [assetId],
        ),
        /verified content hash requires the committed provider receipt/u,
      );

      const provider = new FaultInjectedProviderAdapter();
      await commitGatewayLeaseThroughProvider(client, provider, {
        assetId,
        generation: 0,
        leaseId: 'ee000000-0000-4000-8000-000000000003',
        startingRowVersion: 0,
        objectKey: 'private/content-hash-fence/winner',
        version: 'content-hash-version',
        checksumHex: 'ab'.repeat(32),
        manifestId: 'ee000000-0000-4000-8000-000000000004',
      });
      const completed = await client.query(
        `UPDATE media.assets
         SET state = 'uploaded', content_hash = expected_content_hash,
             uploaded_at = clock_timestamp(), row_version = row_version + 1
         WHERE id = $1 AND state = 'pending_upload' AND row_version = 1`,
        [assetId],
      );
      assert.equal(completed.rowCount, 1);
    });
  },
);

void postgresTest(
  'uses exact operation enums, trusted media origins, and report receipt identities for replay JSON',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const invalid = await client.query<{ safe: boolean }>(
        `SELECT media.safe_completion_replay_json(
                  '{"assetId":"ef000000-0000-4000-8000-000000000001","state":"forged"}'::jsonb
                ) AS safe
         UNION ALL
         SELECT media.safe_mutation_replay_json(
                  'event_attachment',
                  '{"id":"ef000000-0000-4000-8000-000000000002","eventId":"ef000000-0000-4000-8000-000000000003","assetId":"ef000000-0000-4000-8000-000000000004","kind":"arbitrary","sortOrder":0,"mediaCount":1}'::jsonb
                )
         UNION ALL
         SELECT media.safe_mutation_replay_json(
                  'profile_attachment',
                  '{"assetId":"ef000000-0000-4000-8000-000000000004","profileId":"ef000000-0000-4000-8000-000000000005","url":"https://evil.example/public/avatar.webp","version":1}'::jsonb
                )
         UNION ALL
         SELECT media.safe_mutation_replay_json(
                  'report_submission',
                  '{"reportId":"ef000000-0000-4000-8000-000000000006","caseId":"not-a-uuid","state":"open"}'::jsonb
                )`,
      );
      assert.deepEqual(invalid.rows, [
        { safe: false },
        { safe: false },
        { safe: false },
        { safe: false },
      ]);

      const valid = await client.query<{ safe: boolean }>(
        `SELECT media.safe_completion_replay_json(
                  '{"assetId":"ef000000-0000-4000-8000-000000000001","state":"processing","moderationState":"pending"}'::jsonb
                ) AS safe
         UNION ALL
         SELECT media.safe_mutation_replay_json(
                  'profile_attachment',
                  '{"assetId":"ef000000-0000-4000-8000-000000000004","profileId":"ef000000-0000-4000-8000-000000000005","url":"https://media.spott.jp/public/avatar.webp","version":1}'::jsonb
                )
         UNION ALL
         SELECT media.safe_mutation_replay_json(
                  'report_submission',
                  '{"reportId":"ef000000-0000-4000-8000-000000000006","caseId":"ef000000-0000-4000-8000-000000000007","publicReference":"SPT-2026-ABCDEF123456","state":"open"}'::jsonb
                )`,
      );
      assert.deepEqual(valid.rows, [{ safe: true }, { safe: true }, { safe: true }]);
    });
  },
);

void postgresTest(
  'keeps a restricted production runtime role outside the owner-transfer authorization ledger',
  async () => {
    await withOwnedDatabase(async (client) => {
      await applyMigrations(client);
      const runtimeRole = `spott_runtime_${randomUUID().replaceAll('-', '')}`;
      const sourceId = 'f0000000-0000-4000-8000-000000000001';
      const targetId = 'f0000000-0000-4000-8000-000000000002';
      const jobId = 'f0000000-0000-4000-8000-000000000003';
      await insertUser(client, sourceId, 'runtime_boundary_source');
      await insertUser(client, targetId, 'runtime_boundary_target');
      const assetId = await claimUploadAttempt(client, {
        ownerId: sourceId,
        attemptId: 'f0000000-0000-4000-8000-000000000004',
        intentHashHex: '1e'.repeat(32),
      });
      assert.ok(assetId);
      await client.query(
        `INSERT INTO identity.account_merge_jobs(
           id, source_user_id, target_user_id, preview_json, expires_at
         ) VALUES ($1, $2, $3, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
        [jobId, sourceId, targetId],
      );

      await client.query(`CREATE ROLE ${runtimeRole} NOLOGIN`);
      try {
        await client.query(`GRANT USAGE ON SCHEMA media TO ${runtimeRole}`);
        await client.query(`GRANT SELECT ON media.assets TO ${runtimeRole}`);
        await client.query(`GRANT UPDATE (current_owner_id) ON media.assets TO ${runtimeRole}`);
        await client.query(`SET ROLE ${runtimeRole}`);
        await assert.rejects(
          client.query(
            `INSERT INTO media.account_merge_transfer_authorizations(
               job_id, source_owner_id, target_owner_id, transaction_id,
               backend_pid, state
             ) VALUES ($1, $2, $3, pg_current_xact_id(), pg_backend_pid(), 'active')`,
            [jobId, sourceId, targetId],
          ),
          /permission denied/u,
        );
        await assert.rejects(
          client.query('UPDATE media.assets SET current_owner_id = $2 WHERE id = $1', [
            assetId,
            targetId,
          ]),
          /direct media owner updates are forbidden/u,
        );
      } finally {
        await client.query('RESET ROLE').catch(() => undefined);
        await client.query(`DROP OWNED BY ${runtimeRole}`).catch(() => undefined);
        await client.query(`DROP ROLE ${runtimeRole}`).catch(() => undefined);
      }
    });
  },
);
