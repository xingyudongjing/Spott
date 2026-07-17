import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { resolveLockedIOSDestination } from './ios-test-destination.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const toolchainLockPath = join(repositoryRoot, 'ci/toolchain-lock.json');

void test('defaults every native E2E run to the locked iOS 26.5 runtime', () => {
  assert.equal(
    resolveLockedIOSDestination(undefined, toolchainLockPath),
    'platform=iOS Simulator,OS=26.5,name=iPhone 17 Pro',
  );
});

void test('accepts only explicit destinations that retain the exact locked runtime', () => {
  assert.equal(
    resolveLockedIOSDestination('platform=iOS Simulator,OS=26.5,name=Spott-CI', toolchainLockPath),
    'platform=iOS Simulator,OS=26.5,name=Spott-CI',
  );
  for (const destination of [
    'platform=iOS Simulator,name=Spott-CI',
    'platform=iOS Simulator,OS=18.5,name=Spott-CI',
    'platform=iOS Simulator,OS=26.4,name=Spott-CI',
    'platform=iOS Simulator,OS=26.5,id=unreviewed-device',
  ]) {
    assert.throws(
      () => resolveLockedIOSDestination(destination, toolchainLockPath),
      /IOS_DESTINATION_RUNTIME_MISMATCH/u,
    );
  }
});
