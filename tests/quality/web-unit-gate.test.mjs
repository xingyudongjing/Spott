import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const webPackage = JSON.parse(readFileSync(join(repositoryRoot, 'apps/web/package.json'), 'utf8'));
const turbo = JSON.parse(readFileSync(join(repositoryRoot, 'turbo.json'), 'utf8'));
const ciWorkflow = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');

function invokedTestScripts(command) {
  return [...command.matchAll(/\b(?:pnpm|npm)\s+(?:run\s+)?(test(?::[a-z0-9-]+)?)(?=\s|&&|$)/giu)]
    .map((match) => match[1]);
}

test('the Web test gate composes Vitest and rendered build tests without recursion', () => {
  assert.equal(webPackage.scripts['test:unit'], 'vitest run');
  assert.deepEqual(invokedTestScripts(webPackage.scripts.test), [
    'test:unit',
    'test:rendered',
  ]);
  assert.match(webPackage.scripts['test:rendered'], /\bpnpm run build\b/u);
  assert.match(
    webPackage.scripts['test:rendered'],
    /\bnode --test --test-force-exit tests\/\*\.test\.mjs\b/u,
  );

  for (const scriptName of ['test:unit', 'test:rendered']) {
    assert.equal(
      invokedTestScripts(webPackage.scripts[scriptName]).includes('test'),
      false,
      `${scriptName} must not call the parent test script`,
    );
  }
});

test('the root and CI test paths naturally reach the Web package test gate', () => {
  assert.match(rootPackage.scripts.test, /\bturbo run test\b/u);
  assert.ok(turbo.tasks.test, 'Turbo must expose a test task');
  assert.match(ciWorkflow, /turbo run [^\n]*\btest\b[^\n]*--force/u);
});
