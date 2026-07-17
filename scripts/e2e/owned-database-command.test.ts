import assert from 'node:assert/strict';
import test from 'node:test';

import { runOwnedDatabaseCommand } from './owned-database-command.js';

const identity = {
  runId: '0123456789abcdef0123456789abcdef',
  runToken: 'ab'.repeat(32),
  tokenHash: 'cd'.repeat(32),
  databaseName: 'spott_ci_0123456789abcdef0123456789abcdef_test',
};
const adminURL = 'postgres://postgres@127.0.0.1:55432/postgres';

function fixture(options: { commandFailure?: Error; cleanupFailure?: Error } = {}) {
  const events: string[] = [];
  let captured:
    | {
        command: string;
        arguments_: string[];
        environment: NodeJS.ProcessEnv;
      }
    | undefined;
  const dependencies = {
    createIdentity: () => identity,
    createCoordinator: (input: {
      adminURL: string;
      targetURL: string;
      runId: string;
      runToken: string;
    }) => {
      events.push(`coordinator:${input.targetURL}`);
      assert.equal(input.adminURL, adminURL);
      assert.equal(input.runId, identity.runId);
      assert.equal(input.runToken, identity.runToken);
      return {
        provision: async () => {
          events.push('provision');
          return { status: 'created' as const, databaseName: identity.databaseName };
        },
        verifyReady: async () => {
          events.push('verify-ready');
          return { databaseName: identity.databaseName };
        },
        cleanup: async () => {
          events.push('cleanup');
          if (options.cleanupFailure) throw options.cleanupFailure;
          return { status: 'deleted' as const, databaseName: identity.databaseName };
        },
      };
    },
    runCommand: async (input: {
      command: string;
      arguments_: string[];
      environment: NodeJS.ProcessEnv;
    }) => {
      events.push('command');
      captured = input;
      if (options.commandFailure) throw options.commandFailure;
    },
  };
  return { events, dependencies, captured: () => captured };
}

test('provisions an unpredictable owned target, keeps ownership proof in the parent, then cleans up', async () => {
  const state = fixture();
  const baseEnvironment = {
    PATH: '/reviewed/bin',
    UNRELATED: 'preserved',
    SPOTT_CI_ADMIN_DATABASE_URL: 'must-not-propagate',
    SPOTT_DATABASE_ADMIN_URL: 'must-not-propagate',
    SPOTT_DATABASE_RUN_ID: 'must-not-propagate',
    SPOTT_DATABASE_RUN_TOKEN: 'must-not-propagate',
  };

  await runOwnedDatabaseCommand(
    {
      adminURL,
      command: '/reviewed/bin/pnpm',
      arguments: ['test:integration:postgres'],
      environment: baseEnvironment,
    },
    state.dependencies,
  );

  assert.deepEqual(state.events, [
    `coordinator:postgres://postgres@127.0.0.1:55432/${identity.databaseName}`,
    'provision',
    'verify-ready',
    'command',
    'cleanup',
  ]);
  assert.deepEqual(state.captured(), {
    command: '/reviewed/bin/pnpm',
    arguments_: ['test:integration:postgres'],
    environment: {
      PATH: '/reviewed/bin',
      UNRELATED: 'preserved',
      SPOTT_TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:55432/${identity.databaseName}`,
    },
  });
  assert.equal(baseEnvironment.SPOTT_DATABASE_RUN_TOKEN, 'must-not-propagate');
});

test('malformed admin URL returns a fixed redacted error before coordinator construction', async () => {
  const sentinel = 'MUST_NOT_PRINT_DB_TOKEN_7F921';
  const state = fixture();
  await assert.rejects(
    runOwnedDatabaseCommand(
      { adminURL: sentinel, command: 'pnpm', arguments: ['test'], environment: {} },
      state.dependencies,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'DATABASE_ENDPOINT_INVALID');
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      assert.equal(String(error).includes(sentinel), false);
      return true;
    },
  );
  assert.deepEqual(state.events, []);
});

test('command failure still proves cleanup and is never converted into success', async () => {
  const failure = new Error('COMMAND_FAILED');
  const state = fixture({ commandFailure: failure });

  await assert.rejects(
    runOwnedDatabaseCommand(
      { adminURL, command: 'pnpm', arguments: ['test'], environment: {} },
      state.dependencies,
    ),
    failure,
  );
  assert.deepEqual(state.events.slice(-2), ['command', 'cleanup']);
});

test('cleanup failure fails a successful command', async () => {
  const failure = new Error('CLEANUP_FAILED');
  const state = fixture({ cleanupFailure: failure });

  await assert.rejects(
    runOwnedDatabaseCommand(
      { adminURL, command: 'pnpm', arguments: ['test'], environment: {} },
      state.dependencies,
    ),
    failure,
  );
  assert.deepEqual(state.events.slice(-2), ['command', 'cleanup']);
});

test('command and cleanup failures are both retained', async () => {
  const state = fixture({
    commandFailure: new Error('COMMAND_FAILED'),
    cleanupFailure: new Error('CLEANUP_FAILED'),
  });

  await assert.rejects(
    runOwnedDatabaseCommand(
      { adminURL, command: 'pnpm', arguments: ['test'], environment: {} },
      state.dependencies,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'OWNED_DATABASE_COMMAND_AND_CLEANUP_FAILED');
      assert.deepEqual(
        error.errors.map((entry) => (entry as Error).message),
        ['COMMAND_FAILED', 'CLEANUP_FAILED'],
      );
      return true;
    },
  );
});
