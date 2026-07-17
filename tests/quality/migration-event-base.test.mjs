import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMigrationBaseSHA } from '../../scripts/ci/migration-event-base.mjs';

const pullBase = '1'.repeat(40);
const mergeBase = '2'.repeat(40);
const pushBase = '3'.repeat(40);
const head = '4'.repeat(40);
const parent = '5'.repeat(40);

test('resolves exact immutable bases for every required workflow event', async (t) => {
  await t.test('pull request', () => {
    assert.equal(
      resolveMigrationBaseSHA({
        eventName: 'pull_request',
        event: { pull_request: { base: { sha: pullBase } } },
        headSHA: head,
        resolveParent: () => parent,
      }),
      pullBase,
    );
  });
  await t.test('merge group', () => {
    assert.equal(
      resolveMigrationBaseSHA({
        eventName: 'merge_group',
        event: { merge_group: { base_sha: mergeBase } },
        headSHA: head,
        resolveParent: () => parent,
      }),
      mergeBase,
    );
  });
  await t.test('protected push', () => {
    assert.equal(
      resolveMigrationBaseSHA({
        eventName: 'push',
        event: { before: pushBase },
        headSHA: head,
        resolveParent: () => parent,
      }),
      pushBase,
    );
  });
  await t.test('manual dispatch compares the exact head parent', () => {
    let requested;
    assert.equal(
      resolveMigrationBaseSHA({
        eventName: 'workflow_dispatch',
        event: {},
        headSHA: head,
        resolveParent: (value) => {
          requested = value;
          return parent;
        },
      }),
      parent,
    );
    assert.equal(requested, head);
  });
});

for (const [name, input] of [
  [
    'unsupported event',
    { eventName: 'schedule', event: {}, headSHA: head, resolveParent: () => parent },
  ],
  [
    'abbreviated pull base',
    {
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: pullBase.slice(0, 12) } } },
      headSHA: head,
      resolveParent: () => parent,
    },
  ],
  [
    'zero push base',
    {
      eventName: 'push',
      event: { before: '0'.repeat(40) },
      headSHA: head,
      resolveParent: () => parent,
    },
  ],
  [
    'branch-name parent',
    {
      eventName: 'workflow_dispatch',
      event: {},
      headSHA: head,
      resolveParent: () => 'main',
    },
  ],
]) {
  test(`fails closed for ${name}`, () => {
    assert.throws(() => resolveMigrationBaseSHA(input), /MIGRATION_BASE_INVALID/u);
  });
}
