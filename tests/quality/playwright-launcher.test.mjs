import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const launcher = join(repositoryRoot, 'scripts/ci/run-verified-playwright.mjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture({ replaceableRuntime = false } = {}) {
  // macOS exposes the temporary directory through /var, while child process
  // cwd resolves to its canonical /private/var path. Keep the fixture on the
  // same canonical path so the positive case does not rely on a symlink alias.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spott-playwright-launcher-')));
  const marker = join(root, 'cli-launched');
  const packageDirectory = join(root, 'package');
  mkdirSync(packageDirectory);
  const packagePath = join(packageDirectory, 'package.json');
  writeFileSync(packagePath, '{"version":"1.61.1"}\n', { mode: 0o600 });
  writeFileSync(
    join(packageDirectory, 'cli.js'),
    [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(marker)}, 'launched\\n');`,
      "if (!/^[a-f0-9]{64}$/.test(process.env.SPOTT_PLAYWRIGHT_RUNTIME_ATTESTATION ?? '')) process.exit(21);",
      'if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) process.exit(22);',
      "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['test','--config=playwright.config.ts','--list'])) process.exit(23);",
      'if (process.env.DATABASE_URL || process.env.SPOTT_DATABASE_ADMIN_URL || process.env.PLAYWRIGHT_SECRET_SENTINEL) process.exit(24);',
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ database: process.env.SPOTT_TEST_DATABASE_URL ?? null, output: process.env.SPOTT_E2E_OUTPUT_DIR ?? null }) + '\\n');`,
    ].join('\n'),
    { mode: 0o600 },
  );

  let rootPrefix = '/';
  let chromiumPath = '/usr/bin/true';
  let ffmpegPath = '/usr/bin/false';
  if (replaceableRuntime) {
    rootPrefix = join(root, 'runtime');
    chromiumPath = '/ms-playwright/chromium/chrome';
    ffmpegPath = '/ms-playwright/ffmpeg/ffmpeg';
    for (const path of [chromiumPath, ffmpegPath]) {
      const absolute = join(rootPrefix, path.slice(1));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `replaceable ${path}\n`, { mode: 0o700 });
    }
  }
  const chromium = readFileSync(
    replaceableRuntime ? join(rootPrefix, chromiumPath.slice(1)) : chromiumPath,
  );
  const ffmpeg = readFileSync(
    replaceableRuntime ? join(rootPrefix, ffmpegPath.slice(1)) : ffmpegPath,
  );
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
  const lockPath = join(root, 'toolchain-lock.json');
  writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  return { root, rootPrefix, lockPath, packagePath, marker };
}

function run(paths, environment = {}, cwd = repositoryRoot) {
  return spawnSync(
    process.execPath,
    [
      launcher,
      '--lock',
      paths.lockPath,
      '--package-json',
      paths.packagePath,
      '--root-prefix',
      paths.rootPrefix,
      '--mode',
      'list',
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        PLAYWRIGHT_SECRET_SENTINEL: 'MUST_NOT_PRINT_9B20F',
        ...environment,
      },
    },
  );
}

test('one wrapper verifies, launches the exact Playwright CLI, and re-verifies runtime bytes', () => {
  const paths = fixture();
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'VERIFIED_PLAYWRIGHT_OK mode=list\n');
  assert.deepEqual(JSON.parse(readFileSync(paths.marker, 'utf8')), {
    database: null,
    output: null,
  });
});

test('launcher forwards only a validated owned database and repository output path', () => {
  const paths = fixture();
  const database =
    'postgres://spott:private@127.0.0.1:5432/spott_ci_0123456789abcdef0123456789abcdef_test';
  const output = join(
    paths.root,
    'output/playwright/core-journey/0123456789abcdef0123456789abcdef',
  );
  const result = run(
    paths,
    {
      DATABASE_URL: 'postgres://admin:must-not-cross@127.0.0.1:5432/postgres',
      SPOTT_DATABASE_ADMIN_URL: 'postgres://admin:must-not-cross@127.0.0.1:5432/postgres',
      SPOTT_TEST_DATABASE_URL: database,
      SPOTT_E2E_OUTPUT_DIR: output,
    },
    paths.root,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(paths.marker, 'utf8')), { database, output });
  assert.equal(`${result.stdout}${result.stderr}`.includes('must-not-cross'), false);
});

test('launcher rejects a non-owned database URL before Playwright code executes', () => {
  const paths = fixture();
  const result = run(paths, {
    SPOTT_TEST_DATABASE_URL: 'postgres://spott:private@127.0.0.1:5432/spott',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'PLAYWRIGHT_DATABASE_URL_INVALID\n');
  assert.equal(existsSync(paths.marker), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('private'), false);
});

test('launcher rejects an output path outside the repository evidence root', () => {
  const paths = fixture();
  const result = run(
    paths,
    { SPOTT_E2E_OUTPUT_DIR: join(paths.root, 'escaped') },
    paths.root,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'PLAYWRIGHT_OUTPUT_PATH_INVALID\n');
  assert.equal(existsSync(paths.marker), false);
});

test('launcher rejects a symlinked output ancestor before Playwright code executes', () => {
  const paths = fixture();
  const outputParent = join(paths.root, 'output');
  const redirected = join(paths.root, 'redirected');
  mkdirSync(outputParent);
  mkdirSync(redirected);
  symlinkSync(redirected, join(outputParent, 'playwright'));
  const result = run(
    paths,
    {
      SPOTT_E2E_OUTPUT_DIR: join(
        outputParent,
        'playwright/core-journey/0123456789abcdef0123456789abcdef',
      ),
    },
    paths.root,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'PLAYWRIGHT_OUTPUT_PATH_INVALID\n');
  assert.equal(existsSync(paths.marker), false);
});

test('replaceable runtime bytes are rejected before Playwright code executes', () => {
  const paths = fixture({ replaceableRuntime: true });
  const result = run(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'PLAYWRIGHT_BINARY_REPLACEABLE\n');
  assert.equal(existsSync(paths.marker), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT_9B20F'), false);
});

test('launcher evidence inputs and fake CLI remain regular non-writable-by-others files', () => {
  const paths = fixture();
  for (const path of [paths.lockPath, paths.packagePath]) {
    const metadata = statSync(path);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o022, 0);
  }
});
