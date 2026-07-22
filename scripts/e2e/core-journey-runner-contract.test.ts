import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { resolvePostgresSocketDirectory } from './postgres-socket-path.js';

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

void test('session E2E injects complete independent BFF and refresh-derivation keyrings', async () => {
  const source = await readFile(runnerPath, 'utf8');
  const sharedStart = source.indexOf('const sharedEnvironment');
  const sharedEnd = source.indexOf('let apiProcess');
  const sharedBlock = source.slice(sharedStart, sharedEnd);

  assert.match(sharedBlock, /SPOTT_WEB_BFF_KEYS/u);
  assert.match(sharedBlock, /SPOTT_WEB_BFF_CURRENT_KID/u);
  assert.match(sharedBlock, /REFRESH_TOKEN_DERIVATION_KEYS/u);
  assert.match(sharedBlock, /REFRESH_TOKEN_DERIVATION_CURRENT_KID/u);
  assert.match(sharedBlock, /WEB_SESSION_COMPLETION_RECOVERY_SECONDS/u);
  assert.match(source, /const webBFFKey = randomBytes\(32\)/u);
  assert.match(source, /const refreshDerivationKey = randomBytes\(32\)/u);
});

void test('browser acceptance enters through owned loopback HTTPS origins', async () => {
  const source = await readFile(runnerPath, 'utf8');

  assert.match(source, /findUniqueAvailablePorts\(6\)/u);
  assert.match(source, /startLoopbackHTTPSProxy/u);
  assert.match(source, /createLoopbackCertificateArguments/u);
  assert.match(source, /VINEXT_TRUST_PROXY:\s*['"]1['"]/u);
  assert.match(source, /const webOrigin = `https:\/\/127\.0\.0\.1:/u);
  assert.match(source, /const publicAPIBaseURL = `https:\/\/127\.0\.0\.1:/u);
  assert.match(source, /SPOTT_WEB_CANONICAL_ORIGIN:\s*webOrigin/u);
  assert.match(source, /PLAYWRIGHT_BASE_URL:\s*webOrigin/u);
  assert.match(source, /NEXT_PUBLIC_API_URL:\s*publicAPIBaseURL/u);
  assert.match(source, /trustedLoopbackCertificate/u);
  assert.doesNotMatch(source, /SPOTT_WEB_CANONICAL_ORIGIN:\s*`http:\/\//u);
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED/u);
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

void test('PostgreSQL socket ownership remains unpredictable without exceeding macOS sun_path', () => {
  const runId = '0123456789abcdef0123456789abcdef';
  const longSystemTemporaryDirectory = `/var/folders/${'a'.repeat(96)}/T`;
  const socketDirectory = resolvePostgresSocketDirectory(
    longSystemTemporaryDirectory,
    runId,
  );
  const socketPath = join(socketDirectory, '.s.PGSQL.65535');

  assert.ok(Buffer.byteLength(socketPath) <= 103);
  assert.match(socketDirectory, /spott-pg-s-[a-f0-9]{16,32}$/u);
  assert.equal(socketDirectory.includes(runId.slice(0, 16)), true);
});
