import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const source = readFileSync(join(repositoryRoot, 'playwright.config.ts'), 'utf8');

test('Playwright uses reviewed bundled Chromium rather than a branded browser channel', () => {
  assert.doesNotMatch(source, /\bchannel\s*:/u);
  assert.match(source, /browserName\s*:\s*["']chromium["']/u);
  assert.doesNotMatch(source, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/u);
  assert.match(source, /SPOTT_PLAYWRIGHT_RUNTIME_ATTESTATION/u);
  assert.match(source, /toolchain-lock\.json/u);
  assert.match(source, /executablePath/u);
});

test('matched Playwright specs cannot override the verified browser with a branded channel', () => {
  const renderedSpec = readFileSync(
    join(repositoryRoot, 'apps/web/tests/discovery-rendered.spec.ts'),
    'utf8',
  );
  assert.doesNotMatch(renderedSpec, /\bchannel\s*:/u);
});

test('an arbitrary executable environment path cannot make the config load', () => {
  const sentinel = '/private/tmp/unverified-chromium-MUST_NOT_USE';
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "await import('./playwright.config.ts')",
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: sentinel,
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
  assert.match(result.stderr, /PLAYWRIGHT_RUNTIME_ATTESTATION_REQUIRED/u);
});

test('Playwright acceptance remains deterministic and retains failure evidence', () => {
  assert.match(source, /workers\s*:\s*1/u);
  assert.match(source, /retries\s*:\s*0/u);
  assert.match(source, /trace\s*:\s*["']retain-on-failure["']/u);
  assert.match(source, /screenshot\s*:\s*["']only-on-failure["']/u);
  assert.match(source, /video\s*:\s*["']retain-on-failure["']/u);
  assert.match(source, /createLoopbackTLSLaunchArguments/u);
  assert.doesNotMatch(source, /ignoreHTTPSErrors\s*:\s*true/u);
});
