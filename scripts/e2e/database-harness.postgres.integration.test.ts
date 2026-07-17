import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import { createDatabaseRunIdentity, quotePostgresIdentifier } from './database-safety.js';
import {
  createPostgresDatabaseOwnershipCoordinator,
  type DatabaseOwnershipCheckpoint,
} from './database-harness.js';

const adminURL = process.env.SPOTT_DATABASE_HARNESS_ADMIN_URL;
const integrationTest = adminURL ? test : test.skip;

function targetURL(databaseName: string): string {
  assert.ok(adminURL);
  const target = new URL(adminURL);
  target.pathname = `/${databaseName}`;
  return target.toString();
}

function harness(
  identity: ReturnType<typeof createDatabaseRunIdentity>,
  checkpoint?: (value: DatabaseOwnershipCheckpoint) => void,
) {
  assert.ok(adminURL);
  return createPostgresDatabaseOwnershipCoordinator({
    adminURL,
    targetURL: targetURL(identity.databaseName),
    runId: identity.runId,
    runToken: identity.runToken,
    ...(checkpoint ? { checkpoint } : {}),
  });
}

void integrationTest(
  'real PostgreSQL registry and target marker survive every provision crash boundary',
  async () => {
    assert.ok(adminURL);
    for (const crashAt of [
      'after_registry_created',
      'after_database_created',
      'after_target_marked',
    ] as const) {
      const identity = createDatabaseRunIdentity();
      await assert.rejects(
        harness(identity, (checkpoint) => {
          if (checkpoint === crashAt) throw new Error(`CRASH:${crashAt}`);
        }).provision(),
        new RegExp(`CRASH:${crashAt}`, 'u'),
      );

      assert.deepEqual(await harness(identity).provision(), {
        status: 'resumed',
        databaseName: identity.databaseName,
      });
      assert.deepEqual(await harness(identity).cleanup(), {
        status: 'deleted',
        databaseName: identity.databaseName,
      });
    }
  },
);

void integrationTest(
  'real PostgreSQL refuses another token and requires registry plus marker for cleanup',
  async () => {
    assert.ok(adminURL);
    const identity = createDatabaseRunIdentity();
    const owner = harness(identity);
    assert.equal((await owner.provision()).status, 'created');

    const impostor = createPostgresDatabaseOwnershipCoordinator({
      adminURL,
      targetURL: targetURL(identity.databaseName),
      runId: identity.runId,
      runToken: createDatabaseRunIdentity().runToken,
    });
    await assert.rejects(impostor.provision(), /DATABASE_OWNERSHIP_MISMATCH/u);
    await assert.rejects(impostor.cleanup(), /DATABASE_OWNERSHIP_MISMATCH/u);

    const target = new Client({ connectionString: targetURL(identity.databaseName) });
    await target.connect();
    await target.query('DELETE FROM spott_ci.database_marker');
    await target.end();
    await assert.rejects(owner.cleanup(), /DATABASE_MARKER_MISSING/u);

    const repair = new Client({ connectionString: targetURL(identity.databaseName) });
    await repair.connect();
    await repair.query(
      `INSERT INTO spott_ci.database_marker(singleton, database_name, token_hash)
     VALUES (true, $1, $2)`,
      [identity.databaseName, identity.tokenHash],
    );
    await repair.end();
    assert.equal((await owner.cleanup()).status, 'deleted');
  },
);

void integrationTest(
  'real PostgreSQL refuses a foreign same-name database without adopting or dropping it',
  async () => {
    assert.ok(adminURL);
    const identity = createDatabaseRunIdentity();
    const admin = new Client({ connectionString: adminURL });
    await admin.connect();
    await admin.query(
      `CREATE DATABASE ${quotePostgresIdentifier(identity.databaseName)} TEMPLATE template0`,
    );
    try {
      await assert.rejects(harness(identity).provision(), /DATABASE_FOREIGN_TARGET/u);
      const exists = await admin.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [identity.databaseName],
      );
      assert.equal(exists.rows[0]?.exists, true);
    } finally {
      await admin.query(`DROP DATABASE ${quotePostgresIdentifier(identity.databaseName)}`);
      await admin.end();
    }
  },
);
