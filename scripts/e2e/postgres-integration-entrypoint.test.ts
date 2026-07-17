import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const entrypointPath = join(repositoryRoot, 'scripts/ci/run-postgres-integration.ts');

test('PostgreSQL integration entrypoint uses the shared owned-database command boundary', () => {
  const source = readFileSync(entrypointPath, 'utf8');
  assert.match(source, /runOwnedDatabaseCommand/u);
  assert.match(source, /SPOTT_CI_ADMIN_DATABASE_URL/u);
  assert.match(source, /scripts\/test-postgis\.ts/u);
  assert.doesNotMatch(source, /arguments:\s*\[\s*['"]test:integration:postgres/u);
  assert.doesNotMatch(source, /createdb|dropdb|DROP DATABASE|CREATE DATABASE/u);
  assert.doesNotMatch(source, /shell\s*:\s*true|execSync|\bexec\(/u);
  assert.doesNotMatch(source, /5432|spott_ci_[a-f0-9]+_test/u);
});

test('PostgreSQL integration entrypoint never echoes a malformed admin credential', () => {
  const sentinel = 'MUST_NOT_PRINT_DB_TOKEN_7F921';
  const result = spawnSync(process.execPath, ['--import', 'tsx', entrypointPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SPOTT_CI_ADMIN_DATABASE_URL: sentinel },
  });
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
  assert.match(result.stderr, /DATABASE_ENDPOINT_INVALID/u);
});

test('PostGIS runner passes only a sanitized environment into integration specs', () => {
  const source = readFileSync(join(repositoryRoot, 'scripts/test-postgis.ts'), 'utf8');
  const spawnBlock = source.slice(source.indexOf("const child = spawn("));
  assert.doesNotMatch(spawnBlock, /\.\.\.process\.env/u);
  assert.match(spawnBlock, /SPOTT_TEST_DATABASE_URL/u);
  assert.match(spawnBlock, /DATABASE_URL/u);
  assert.doesNotMatch(spawnBlock, /SPOTT_DATABASE_(?:ADMIN_URL|RUN_ID|RUN_TOKEN)/u);
});
