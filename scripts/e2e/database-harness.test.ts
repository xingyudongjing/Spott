import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DatabaseOwnershipCoordinator,
  type DatabaseMarker,
  type DatabaseOwnershipAdapter,
  type DatabaseOwnershipCheckpoint,
  type DatabaseRegistryRow,
} from './database-harness.js';

const databaseName = 'spott_ci_0123456789abcdef0123456789abcdef_test';
const tokenHash = 'a'.repeat(64);
const otherTokenHash = 'b'.repeat(64);

class FakeAdapter implements DatabaseOwnershipAdapter {
  registry: DatabaseRegistryRow | undefined;
  target: { marker?: DatabaseMarker } | undefined;
  readonly events: string[] = [];
  createRace = false;

  async withAdminLock<T>(_databaseName: string, operation: () => Promise<T>): Promise<T> {
    this.events.push('lock');
    return operation();
  }

  async readRegistry(): Promise<DatabaseRegistryRow | undefined> {
    this.events.push('read-registry');
    return this.registry;
  }

  async targetExists(): Promise<boolean> {
    this.events.push('target-exists');
    return this.target !== undefined;
  }

  async insertCreating(row: DatabaseRegistryRow): Promise<void> {
    this.events.push('insert-creating');
    this.registry = { ...row };
  }

  async createTarget(): Promise<void> {
    this.events.push('create-target');
    if (this.createRace) {
      this.target = {};
      throw new Error('DATABASE_ALREADY_EXISTS');
    }
    this.target = {};
  }

  async readMarker(): Promise<DatabaseMarker | undefined> {
    this.events.push('read-marker');
    return this.target?.marker;
  }

  async writeMarker(marker: DatabaseMarker): Promise<void> {
    this.events.push('write-marker');
    assert.ok(this.target);
    this.target.marker = { ...marker };
  }

  async markReady(): Promise<void> {
    this.events.push('mark-ready');
    assert.ok(this.registry);
    this.registry.state = 'ready';
  }

  async markDeleting(): Promise<void> {
    this.events.push('mark-deleting');
    assert.ok(this.registry);
    this.registry.state = 'deleting';
  }

  async quarantine(): Promise<void> {
    this.events.push('quarantine');
    assert.ok(this.registry);
    this.registry.state = 'quarantined';
  }

  async dropTarget(): Promise<void> {
    this.events.push('drop-target');
    this.target = undefined;
  }

  async deleteRegistry(): Promise<void> {
    this.events.push('delete-registry');
    this.registry = undefined;
  }
}

function coordinator(
  adapter: FakeAdapter,
  options: {
    hash?: string;
    checkpoint?: (checkpoint: DatabaseOwnershipCheckpoint) => void;
  } = {},
) {
  return new DatabaseOwnershipCoordinator({
    adapter,
    databaseName,
    tokenHash: options.hash ?? tokenHash,
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
  });
}

void test('provisions in registry-create-marker-ready order under one admin lock', async () => {
  const adapter = new FakeAdapter();
  const result = await coordinator(adapter).provision();

  assert.deepEqual(result, { status: 'created', databaseName });
  assert.deepEqual(adapter.registry, { databaseName, tokenHash, state: 'ready' });
  assert.deepEqual(adapter.target?.marker, { databaseName, tokenHash });
  assert.deepEqual(adapter.events, [
    'lock',
    'read-registry',
    'target-exists',
    'insert-creating',
    'create-target',
    'read-marker',
    'write-marker',
    'mark-ready',
  ]);
});

for (const checkpoint of [
  'after_registry_created',
  'after_database_created',
  'after_target_marked',
] as const) {
  void test(`same token resumes safely after crash at ${checkpoint}`, async () => {
    const adapter = new FakeAdapter();
    await assert.rejects(
      coordinator(adapter, {
        checkpoint: (current) => {
          if (current === checkpoint) throw new Error(`CRASH:${checkpoint}`);
        },
      }).provision(),
      new RegExp(`CRASH:${checkpoint}`, 'u'),
    );

    const resumed = await coordinator(adapter).provision();
    assert.deepEqual(resumed, { status: 'resumed', databaseName });
    assert.equal(adapter.registry?.state, 'ready');
    assert.deepEqual(adapter.target?.marker, { databaseName, tokenHash });
  });
}

void test('a ready target with matching registry and marker is reusable only by the same run', async () => {
  const adapter = new FakeAdapter();
  await coordinator(adapter).provision();
  adapter.events.length = 0;

  assert.deepEqual(await coordinator(adapter).provision(), { status: 'ready', databaseName });
  await assert.rejects(
    coordinator(adapter, { hash: otherTokenHash }).provision(),
    /DATABASE_OWNERSHIP_MISMATCH/u,
  );
  assert.equal(adapter.registry?.state, 'ready');
  assert.deepEqual(adapter.target?.marker, { databaseName, tokenHash });
});

void test('read-only readiness proof never creates or adopts a database', async () => {
  const ready = new FakeAdapter();
  await coordinator(ready).provision();
  ready.events.length = 0;

  assert.deepEqual(await coordinator(ready).verifyReady(), { databaseName });
  assert.deepEqual(ready.events, ['lock', 'read-registry', 'target-exists', 'read-marker']);

  const absent = new FakeAdapter();
  await assert.rejects(coordinator(absent).verifyReady(), /DATABASE_OWNERSHIP_PROOF_MISSING/u);
  assert.equal(absent.events.includes('insert-creating'), false);
  assert.equal(absent.events.includes('create-target'), false);

  await assert.rejects(
    coordinator(ready, { hash: otherTokenHash }).verifyReady(),
    /DATABASE_OWNERSHIP_MISMATCH/u,
  );
});

void test('foreign same-name database is refused and never adopted or dropped', async () => {
  const adapter = new FakeAdapter();
  adapter.target = {};

  await assert.rejects(coordinator(adapter).provision(), /DATABASE_FOREIGN_TARGET/u);
  assert.equal(adapter.registry, undefined);
  assert.ok(adapter.target);
  assert.equal(adapter.events.includes('write-marker'), false);
  assert.equal(adapter.events.includes('drop-target'), false);
});

void test('a CREATE DATABASE TOCTOU race is quarantined instead of adopted', async () => {
  const adapter = new FakeAdapter();
  adapter.createRace = true;

  await assert.rejects(coordinator(adapter).provision(), /DATABASE_CREATE_RACE/u);
  assert.equal(adapter.registry?.state, 'quarantined');
  assert.ok(adapter.target);
  assert.equal(adapter.target?.marker, undefined);
});

void test('half-created or mismatched state never crosses the ownership boundary', async (t) => {
  await t.test('creating registry owned by another token', async () => {
    const adapter = new FakeAdapter();
    adapter.registry = { databaseName, tokenHash: otherTokenHash, state: 'creating' };
    await assert.rejects(coordinator(adapter).provision(), /DATABASE_OWNERSHIP_MISMATCH/u);
    assert.equal(adapter.target, undefined);
  });

  await t.test('ready registry without target', async () => {
    const adapter = new FakeAdapter();
    adapter.registry = { databaseName, tokenHash, state: 'ready' };
    await assert.rejects(coordinator(adapter).provision(), /DATABASE_HALF_CREATED/u);
    assert.equal(adapter.registry.state, 'quarantined');
  });

  await t.test('ready registry with missing marker', async () => {
    const adapter = new FakeAdapter();
    adapter.registry = { databaseName, tokenHash, state: 'ready' };
    adapter.target = {};
    await assert.rejects(coordinator(adapter).provision(), /DATABASE_MARKER_MISSING/u);
    assert.equal(adapter.registry.state, 'quarantined');
  });

  await t.test('marker belongs to another token', async () => {
    const adapter = new FakeAdapter();
    adapter.registry = { databaseName, tokenHash, state: 'creating' };
    adapter.target = { marker: { databaseName, tokenHash: otherTokenHash } };
    await assert.rejects(coordinator(adapter).provision(), /DATABASE_MARKER_MISMATCH/u);
    assert.equal(adapter.registry.state, 'quarantined');
  });
});

void test('cleanup proves registry and marker before marking deleting and dropping', async () => {
  const adapter = new FakeAdapter();
  await coordinator(adapter).provision();
  adapter.events.length = 0;

  await coordinator(adapter).cleanup();

  assert.equal(adapter.target, undefined);
  assert.equal(adapter.registry, undefined);
  assert.deepEqual(adapter.events, [
    'lock',
    'read-registry',
    'target-exists',
    'read-marker',
    'mark-deleting',
    'drop-target',
    'delete-registry',
  ]);
});

void test('cleanup refuses a missing marker and resumes after crash between drop and registry deletion', async () => {
  const unsafe = new FakeAdapter();
  unsafe.registry = { databaseName, tokenHash, state: 'ready' };
  unsafe.target = {};
  await assert.rejects(coordinator(unsafe).cleanup(), /DATABASE_MARKER_MISSING/u);
  assert.ok(unsafe.target);

  const resumable = new FakeAdapter();
  await coordinator(resumable).provision();
  await assert.rejects(
    coordinator(resumable, {
      checkpoint: (current) => {
        if (current === 'after_database_dropped') throw new Error('CRASH:after_database_dropped');
      },
    }).cleanup(),
    /CRASH:after_database_dropped/u,
  );
  assert.equal(resumable.registry?.state, 'deleting');
  assert.equal(resumable.target, undefined);

  await coordinator(resumable).cleanup();
  assert.equal(resumable.registry, undefined);
});
