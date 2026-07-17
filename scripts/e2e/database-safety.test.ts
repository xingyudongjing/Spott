import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDatabaseRunIdentity,
  hashRunToken,
  quotePostgresIdentifier,
  validateDatabaseEndpoints,
} from './database-safety.js';

const runId = '0123456789abcdef0123456789abcdef';
const runToken = 'ab'.repeat(32);
const databaseName = `spott_ci_${runId}_test`;
const adminURL = 'postgres://postgres@127.0.0.1:55432/postgres';
const targetURL = `postgres://postgres@127.0.0.1:55432/${databaseName}`;

void test('creates an unpredictable run identity without exposing the ownership token in its name', () => {
  const identity = createDatabaseRunIdentity();

  assert.match(identity.runId, /^[a-f0-9]{32}$/u);
  assert.match(identity.runToken, /^[a-f0-9]{64}$/u);
  assert.equal(identity.databaseName, `spott_ci_${identity.runId}_test`);
  assert.equal(identity.databaseName.includes(identity.runToken), false);
  assert.match(identity.tokenHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(identity.tokenHash, identity.runToken);
});

void test('accepts only a same-endpoint loopback admin/target pair and exact run-owned name', () => {
  const result = validateDatabaseEndpoints({
    adminURL,
    targetURL,
    runId,
    runToken,
  });

  assert.equal(result.databaseName, databaseName);
  assert.equal(result.adminDatabaseName, 'postgres');
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.port, 55432);
  assert.equal(result.tokenHash, hashRunToken(runToken));
  assert.equal(JSON.stringify(result).includes(runToken), false);
});

void test('rejects remote, mismatched, predictable, malformed, or privileged targets', async (t) => {
  const valid = { adminURL, targetURL, runId, runToken };
  const rejects = (input: Partial<typeof valid>, pattern: RegExp) => {
    assert.throws(() => validateDatabaseEndpoints({ ...valid, ...input }), pattern);
  };

  await t.test('remote host', () => {
    rejects(
      {
        targetURL: `postgres://postgres@db.example.com:55432/${databaseName}`,
        adminURL: 'postgres://postgres@db.example.com:55432/postgres',
      },
      /DATABASE_ENDPOINT_NOT_LOCAL/u,
    );
  });
  await t.test('localhost name is not accepted as proof of loopback', () => {
    rejects(
      {
        targetURL: `postgres://postgres@localhost:55432/${databaseName}`,
        adminURL: 'postgres://postgres@localhost:55432/postgres',
      },
      /DATABASE_ENDPOINT_NOT_LOCAL/u,
    );
  });
  await t.test('different ports', () => {
    rejects(
      { targetURL: `postgres://postgres@127.0.0.1:55433/${databaseName}` },
      /DATABASE_ENDPOINT_MISMATCH/u,
    );
  });
  await t.test('different users', () => {
    rejects(
      { targetURL: `postgres://other@127.0.0.1:55432/${databaseName}` },
      /DATABASE_ENDPOINT_MISMATCH/u,
    );
  });
  await t.test('query parameters', () => {
    rejects({ targetURL: `${targetURL}?sslmode=disable` }, /DATABASE_ENDPOINT_AMBIGUOUS/u);
  });
  await t.test('wrong suffix', () => {
    rejects(
      { targetURL: 'postgres://postgres@127.0.0.1:55432/spott_ci_not_test' },
      /DATABASE_NAME_NOT_OWNED/u,
    );
  });
  await t.test('privileged database', () => {
    rejects(
      { targetURL: 'postgres://postgres@127.0.0.1:55432/postgres' },
      /DATABASE_NAME_NOT_OWNED/u,
    );
  });
  await t.test('short run id', () => {
    rejects({ runId: 'abcd' }, /DATABASE_RUN_ID_INVALID/u);
  });
  await t.test('short token', () => {
    rejects({ runToken: 'abcd' }, /DATABASE_RUN_TOKEN_INVALID/u);
  });
  await t.test('token embedded in URL', () => {
    rejects(
      { targetURL: `${targetURL}?application_name=${runToken}` },
      /DATABASE_ENDPOINT_AMBIGUOUS/u,
    );
  });
});

void test('quotes a previously validated PostgreSQL identifier without shell construction', () => {
  assert.equal(quotePostgresIdentifier(databaseName), `"${databaseName}"`);
  assert.throws(() => quotePostgresIdentifier('spott";DROP DATABASE postgres;--_test'), {
    message: /DATABASE_IDENTIFIER_INVALID/u,
  });
});
