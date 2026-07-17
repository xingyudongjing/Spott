import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const verifier = join(repositoryRoot, 'scripts/verify-generated-artifacts.sh');
const generatedFiles = [
  'packages/contracts/openapi.bundle.yaml',
  'packages/api-client/src/schema.d.ts',
];
const fixtureFiles = [
  'package.json',
  'pnpm-workspace.yaml',
  'packages/contracts/package.json',
  'packages/contracts/openapi.yaml',
  'packages/contracts/openapi.bundle.yaml',
  'packages/api-client/package.json',
  'packages/api-client/src/schema.d.ts',
];

function isolatedRepository() {
  const root = mkdtempSync(join(tmpdir(), 'spott-generated-artifacts-'));
  for (const relativePath of fixtureFiles) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, relativePath), destination);
  }
  symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'));
  symlinkSync(
    join(repositoryRoot, 'packages/api-client/node_modules'),
    join(root, 'packages/api-client/node_modules'),
  );
  return root;
}

function runVerifier(root) {
  return spawnSync('bash', [verifier, '--repo-root', root], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function expectRejected(result, filename, secret) {
  assert.notEqual(result.status, 0, `expected drift failure, stdout=${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /GENERATED_DRIFT/u);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(filename.replaceAll('.', '\\.')));
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
}

test('clean isolated generation is byte-stable', () => {
  const root = isolatedRepository();
  const result = runVerifier(root);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /GENERATED_ARTIFACTS_OK/u);
});

for (const relativePath of generatedFiles) {
  test(`rejects tampering in ${relativePath} without printing file contents`, () => {
    const root = isolatedRepository();
    const secret = `DO_NOT_PRINT_${relativePath.replaceAll(/[^A-Za-z]/gu, '_')}`;
    const path = join(root, relativePath);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# ${secret}\n`, { mode: 0o600 });

    const result = runVerifier(root);
    expectRejected(result, relativePath, secret);
  });
}
