import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const verifier = join(repositoryRoot, 'scripts/ci/verify-playwright-runtime.mjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spott-playwright-runtime-'));
  const chromium = Buffer.from('locked chromium fixture\n');
  const ffmpeg = Buffer.from('locked ffmpeg fixture\n');
  const chromiumPath = '/ms-playwright/chromium-1228/chrome-linux64/chrome';
  const ffmpegPath = '/ms-playwright/ffmpeg-1011/ffmpeg-linux';
  for (const [path, contents] of [
    [chromiumPath, chromium],
    [ffmpegPath, ffmpeg],
  ]) {
    const target = join(root, path.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, { mode: 0o700 });
  }
  const packagePath = join(root, 'package.json');
  writeFileSync(packagePath, '{"version":"1.61.1"}\n', { mode: 0o600 });
  const lockPath = join(root, 'toolchain-lock.json');
  const lock = {
    containers: {
      playwright: {
        packageVersion: '1.61.1',
        chromium: {
          path: chromiumPath,
          bytes: chromium.length,
          sha256: sha256(chromium),
        },
        ffmpeg: {
          path: ffmpegPath,
          bytes: ffmpeg.length,
          sha256: sha256(ffmpeg),
        },
      },
    },
  };
  writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  return { root, lockPath, packagePath, lock };
}

function safeFixture() {
  const paths = fixture();
  const chromiumPath = '/usr/bin/true';
  const ffmpegPath = '/usr/bin/false';
  const chromium = readFileSync(chromiumPath);
  const ffmpeg = readFileSync(ffmpegPath);
  paths.root = '/';
  paths.lock.containers.playwright.chromium = {
    path: chromiumPath,
    bytes: statSync(chromiumPath).size,
    sha256: sha256(chromium),
  };
  paths.lock.containers.playwright.ffmpeg = {
    path: ffmpegPath,
    bytes: statSync(ffmpegPath).size,
    sha256: sha256(ffmpeg),
  };
  writeFileSync(paths.lockPath, `${JSON.stringify(paths.lock)}\n`, { mode: 0o600 });
  return paths;
}

function run(paths) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--lock',
      paths.lockPath,
      '--package-json',
      paths.packagePath,
      '--root-prefix',
      paths.root,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PLAYWRIGHT_SECRET_SENTINEL: 'MUST_NOT_PRINT_D802C' },
    },
  );
}

test('accepts the exact package, Chromium, and ffmpeg bytes from the lock', () => {
  const result = run(safeFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'PLAYWRIGHT_RUNTIME_OK\n');
});

test('rejects exact but caller-owned executables because they remain replaceable after hashing', () => {
  const result = run(fixture());
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'PLAYWRIGHT_BINARY_REPLACEABLE\n');
});

for (const [name, createFixture, mutate, code] of [
  [
    'package drift',
    safeFixture,
    (paths) => writeFileSync(paths.packagePath, '{"version":"1.61.0"}\n'),
    'PLAYWRIGHT_PACKAGE_MISMATCH',
  ],
  [
    'Chromium hash drift',
    safeFixture,
    (paths) => {
      paths.lock.containers.playwright.chromium.sha256 = 'a'.repeat(64);
      writeFileSync(paths.lockPath, `${JSON.stringify(paths.lock)}\n`);
    },
    'PLAYWRIGHT_BINARY_MISMATCH',
  ],
  [
    'ffmpeg hash drift',
    safeFixture,
    (paths) => {
      paths.lock.containers.playwright.ffmpeg.sha256 = 'b'.repeat(64);
      writeFileSync(paths.lockPath, `${JSON.stringify(paths.lock)}\n`);
    },
    'PLAYWRIGHT_BINARY_MISMATCH',
  ],
  [
    'symlinked executable',
    fixture,
    (paths) => {
      const target = join(paths.root, paths.lock.containers.playwright.chromium.path.slice(1));
      const replacement = `${target}.real`;
      writeFileSync(replacement, 'locked chromium fixture\n', { mode: 0o700 });
      writeFileSync(target, 'will be replaced\n');
      symlinkSync(replacement, `${target}.link`);
      paths.lock.containers.playwright.chromium.path = `${paths.lock.containers.playwright.chromium.path}.link`;
      writeFileSync(paths.lockPath, `${JSON.stringify(paths.lock)}\n`);
    },
    'PLAYWRIGHT_BINARY_UNSAFE',
  ],
]) {
  test(`rejects ${name} without printing runtime bytes or environment`, () => {
    const paths = createFixture();
    mutate(paths);
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`^${code}\\n$`, 'u'));
    assert.equal(`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT_D802C'), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes('tampered'), false);
  });
}
