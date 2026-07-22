import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

import { createLoopbackTLSLaunchArguments } from './scripts/e2e/loopback-https-proxy.js';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';
const loopbackTLSLaunchArguments = createLoopbackTLSLaunchArguments(
  baseURL,
  process.env.SPOTT_E2E_TLS_SPKI_SHA256,
);

interface RuntimeBinaryContract {
  path: string;
  sha256: string;
}

interface PlaywrightRuntimeContract {
  packageVersion: string;
  chromium: RuntimeBinaryContract;
  ffmpeg: RuntimeBinaryContract;
}

interface ToolchainLock {
  containers?: { playwright?: PlaywrightRuntimeContract };
}

const toolchainLock = JSON.parse(
  readFileSync(new URL('./ci/toolchain-lock.json', import.meta.url), 'utf8'),
) as ToolchainLock;
const playwrightRuntime = toolchainLock.containers?.playwright;
if (
  !playwrightRuntime ||
  typeof playwrightRuntime.packageVersion !== 'string' ||
  typeof playwrightRuntime.chromium?.path !== 'string' ||
  !playwrightRuntime.chromium.path.startsWith('/ms-playwright/') ||
  !/^[a-f0-9]{64}$/u.test(playwrightRuntime.chromium.sha256) ||
  typeof playwrightRuntime.ffmpeg?.path !== 'string' ||
  !playwrightRuntime.ffmpeg.path.startsWith('/ms-playwright/') ||
  !/^[a-f0-9]{64}$/u.test(playwrightRuntime.ffmpeg.sha256)
) {
  throw new Error('PLAYWRIGHT_RUNTIME_LOCK_INVALID');
}
const expectedAttestation = createHash('sha256')
  .update(
    [
      playwrightRuntime.packageVersion,
      playwrightRuntime.chromium.path,
      playwrightRuntime.chromium.sha256,
      playwrightRuntime.ffmpeg.path,
      playwrightRuntime.ffmpeg.sha256,
    ].join('\u0000'),
  )
  .digest('hex');
if (process.env.SPOTT_PLAYWRIGHT_RUNTIME_ATTESTATION !== expectedAttestation) {
  throw new Error('PLAYWRIGHT_RUNTIME_ATTESTATION_REQUIRED');
}

export default defineConfig({
  testDir: '.',
  testMatch: ['tests/e2e/**/*.spec.ts', 'apps/web/tests/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: 'output/playwright/test-artifacts',
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'output/playwright/report' }]],
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    launchOptions: {
      executablePath: playwrightRuntime.chromium.path,
      args: loopbackTLSLaunchArguments,
    },
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
