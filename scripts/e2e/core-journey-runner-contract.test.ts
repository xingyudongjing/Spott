import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const runnerPath = resolve(repositoryRoot, 'scripts/run-core-journey-e2e.ts');

void test('core journey runner owns every database through the shared two-phase coordinator', async () => {
  const source = await readFile(runnerPath, 'utf8');
  assert.match(source, /createDatabaseRunIdentity/u);
  assert.match(source, /createPostgresDatabaseOwnershipCoordinator/u);
  assert.doesNotMatch(source, /\bcreatedb\b/u);

  const provision = source.indexOf('.provision()');
  const migrate = source.search(/\[['"]db:migrate['"]\]/u);
  const cleanup = source.indexOf('.cleanup()');
  const stop = source.search(/['"]stop['"]/u);
  assert.ok(provision >= 0 && migrate > provision, 'ownership provision must precede migration');
  assert.ok(cleanup >= 0 && stop > cleanup, 'ownership cleanup must precede cluster stop');
});

void test('core journey runner has no developer-machine paths, fixed ports, or shared output', async () => {
  const source = await readFile(runnerPath, 'utf8');
  assert.doesNotMatch(source, /\/opt\/homebrew/u);
  assert.doesNotMatch(source, /const (?:pg|api|web)Port\s*=\s*[0-9_]+/u);
  assert.doesNotMatch(source, /spott_core_journey_e2e_test/u);
  assert.match(source, /createDatabaseRunIdentity/u);
  assert.match(source, /findAvailableLoopbackPort/u);
  assert.match(source, /resolvePostgresBin/u);
  assert.match(source, /SPOTT_E2E_DATABASE_MODE/u);
});

void test('native branch resolves the exact toolchain-locked iOS runtime', async () => {
  const source = await readFile(runnerPath, 'utf8');
  assert.match(source, /resolveLockedIOSDestination/u);
  assert.doesNotMatch(source, /OS=18\.5|iOS-18-5/u);
});

void test('database ownership token is scoped to migration proof and never enters app processes', async () => {
  const source = await readFile(runnerPath, 'utf8');
  const sharedStart = source.indexOf('const sharedEnvironment');
  const sharedEnd = source.indexOf('let apiProcess');
  const sharedBlock = source.slice(sharedStart, sharedEnd);
  assert.doesNotMatch(sharedBlock, /SPOTT_DATABASE_RUN_TOKEN/u);
  assert.match(source, /const migrationEnvironment/u);
  assert.match(source, /SPOTT_DATABASE_RUN_TOKEN/u);
  assert.match(source, /SPOTT_DATABASE_OWNERSHIP_REQUIRED/u);
});

void test('web branch can launch Playwright only through the locked verify-run-verify boundary', async () => {
  const source = await readFile(runnerPath, 'utf8');
  assert.match(source, /join\(root, 'scripts', 'ci', 'run-verified-playwright\.mjs'\)/u);
  assert.match(source, /join\(root, 'ci', 'toolchain-lock\.json'\)/u);
  assert.match(source, /join\(root, 'node_modules', '@playwright', 'test', 'package\.json'\)/u);
  assert.match(source, /'--root-prefix',\s*'\/'/u);
  assert.match(source, /'--mode',\s*'test'/u);
  assert.doesNotMatch(source, /node_modules['"], ['"]\.bin['"], ['"]playwright/u);
  assert.doesNotMatch(source, /playwrightArguments/u);
});
