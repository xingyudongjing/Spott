import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const manifestPath = join(import.meta.dirname, 'integration-coverage.json');
const ignoredDirectories = new Set([
  '.claude',
  '.git',
  '.next',
  '.turbo',
  '.worktrees',
  'DerivedData',
  'dist',
  'node_modules',
  'output',
]);
const allowedGates = new Set([
  'postgres-integration',
  'web-core-journey',
  'nightly-load-concurrency',
  'nightly-accessibility-performance',
  'nightly-backup-restore',
]);
const requiredInfrastructure = new Map([
  ['scripts/ci/run-postgres-integration.ts', ['postgres-integration', 'database-runner']],
  ['scripts/ci/run-verified-playwright.mjs', ['web-core-journey', 'browser-runner']],
  ['scripts/run-core-journey-e2e.ts', ['web-core-journey', 'e2e-runner']],
  ['scripts/test-postgis.ts', ['postgres-integration', 'database-replay']],
]);

function toRepositoryPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function classify(path) {
  if (path.startsWith('tests/load/')) return ['nightly-load-concurrency', 'load'];
  if (path.startsWith('tests/performance/') || path === 'tests/e2e/accessibility.spec.ts') {
    return ['nightly-accessibility-performance', 'accessibility-performance'];
  }
  if (path === 'scripts/ci/backup-restore-drill.sh') {
    return ['nightly-backup-restore', 'backup-restore'];
  }
  if (
    /^tests\/e2e\/.*\.spec\.[cm]?[jt]sx?$/u.test(path) ||
    /^apps\/web\/tests\/.*\.spec\.[cm]?[jt]sx?$/u.test(path)
  ) {
    return ['web-core-journey', 'browser-e2e'];
  }
  if (/^scripts\/e2e\/.*\.postgres\.integration\.test\.[cm]?[jt]sx?$/u.test(path)) {
    return ['postgres-integration', 'database-ownership-integration'];
  }
  if (
    /\.integration\.spec\.[cm]?[jt]sx?$/u.test(path) ||
    /^tests\/integration\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) ||
    /^services\/worker\/.*\.(?:real-service|real_service)\.spec\.[cm]?[jt]sx?$/u.test(path)
  ) {
    return ['postgres-integration', 'service-integration'];
  }
  return undefined;
}

function discoverCoverage(root) {
  const discovered = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = toRepositoryPath(root, absolute);
      const classification = classify(path);
      if (classification) discovered.set(path, classification);
    }
  }
  for (const [path, classification] of requiredInfrastructure) {
    const absolute = join(root, path);
    if (lstatSync(absolute).isFile()) discovered.set(path, classification);
  }
  return discovered;
}

function readManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest).toSorted(), ['entries', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.entries));
  return manifest.entries;
}

test('integration coverage manifest maps every discovered executable to exactly one gate', () => {
  const entries = readManifest();
  const paths = entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].toSorted(), 'coverage entries must be path-sorted');
  assert.equal(new Set(paths).size, paths.length, 'coverage paths must be unique');

  const discovered = discoverCoverage(repositoryRoot);
  assert.deepEqual(paths, [...discovered.keys()].toSorted());
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).toSorted(), ['gate', 'kind', 'path']);
    assert.equal(allowedGates.has(entry.gate), true, entry.path);
    assert.match(entry.path, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
    const metadata = lstatSync(join(repositoryRoot, entry.path));
    assert.equal(metadata.isFile(), true, entry.path);
    assert.equal(metadata.isSymbolicLink(), false, entry.path);
    assert.deepEqual([entry.gate, entry.kind], discovered.get(entry.path), entry.path);
  }
});

test('orphan discovery detects a newly added integration test', () => {
  const root = mkdtempSync(join(tmpdir(), 'spott-integration-coverage-'));
  for (const path of requiredInfrastructure.keys()) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture\n');
  }
  const orphan = join(root, 'services/api/src/new-feature/new.integration.spec.ts');
  mkdirSync(dirname(orphan), { recursive: true });
  writeFileSync(orphan, 'fixture\n');

  assert.deepEqual([...discoverCoverage(root).keys()].toSorted(), [
    'scripts/ci/run-postgres-integration.ts',
    'scripts/ci/run-verified-playwright.mjs',
    'scripts/run-core-journey-e2e.ts',
    'scripts/test-postgis.ts',
    'services/api/src/new-feature/new.integration.spec.ts',
  ]);
});

test('coverage discovery includes every configured Web Playwright and database harness test class', () => {
  const discovered = discoverCoverage(repositoryRoot);
  assert.deepEqual(discovered.get('apps/web/tests/discovery-rendered.spec.ts'), [
    'web-core-journey',
    'browser-e2e',
  ]);
  assert.deepEqual(discovered.get('scripts/e2e/database-harness.postgres.integration.test.ts'), [
    'postgres-integration',
    'database-ownership-integration',
  ]);
});
