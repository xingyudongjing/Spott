import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const workerPackage = JSON.parse(
  readFileSync(join(repositoryRoot, 'services/worker/package.json'), 'utf8'),
);
const postgresRunner = readFileSync(join(repositoryRoot, 'scripts/test-postgis.ts'), 'utf8');
const ciWorkflow = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');

test('Worker unit tests use a deterministic matrix that cannot collect integration suites', () => {
  assert.equal(workerPackage.scripts.test, 'pnpm run test:unit');
  assert.equal(workerPackage.scripts['test:unit'], 'vitest run --config vitest.unit.config.mjs');

  const unitConfig = readFileSync(
    join(repositoryRoot, 'services/worker/vitest.unit.config.mjs'),
    'utf8',
  );
  assert.match(unitConfig, /include:\s*\[['"]test\/\*\*\/\*\.test\.ts['"]\]/u);
  assert.match(
    unitConfig,
    /exclude:\s*\[['"]test\/\*\*\/\*\.integration\.test\.ts['"]\]/u,
  );
  assert.doesNotMatch(
    unitConfig,
    /fileParallelism:\s*false|maxWorkers|minWorkers|testTimeout|hookTimeout|\.skip\b/u,
  );
});

test('Worker PostgreSQL integration remains owned by the dedicated root database gate', () => {
  assert.match(postgresRunner, /workerCleanupSpecification\s*=\s*['"]test\/session-completion-cleanup\.integration\.test\.ts['"]/u);
  assert.match(postgresRunner, /runAll[\s\S]*runVitest\(workerDirectory, \[workerCleanupSpecification\]\)/u);
  assert.match(postgresRunner, /SPOTT_TEST_DATABASE_URL:\s*testDatabaseURL/u);
  assert.match(ciWorkflow, /corepack pnpm test:integration:postgres/u);
});
