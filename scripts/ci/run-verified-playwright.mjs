#!/usr/bin/env node

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { verifyPlaywrightRuntime } from './verify-playwright-runtime.mjs';

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || values.has(flag)) {
      fail('PLAYWRIGHT_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  const required = ['--lock', '--mode', '--package-json', '--root-prefix'];
  if (values.size !== required.length || required.some((flag) => !values.has(flag))) {
    fail('PLAYWRIGHT_ARGUMENTS_INVALID');
  }
  const mode = values.get('--mode');
  if (mode !== 'test' && mode !== 'list') fail('PLAYWRIGHT_ARGUMENTS_INVALID');
  let rootPrefix;
  try {
    rootPrefix = realpathSync(resolve(values.get('--root-prefix')));
  } catch {
    fail('PLAYWRIGHT_INPUT_UNSAFE');
  }
  return {
    lockPath: resolve(values.get('--lock')),
    packagePath: resolve(values.get('--package-json')),
    rootPrefix,
    mode,
  };
}

function playwrightCLI(packagePath) {
  const path = join(dirname(packagePath), 'cli.js');
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail('PLAYWRIGHT_PACKAGE_INVALID');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
    fail('PLAYWRIGHT_PACKAGE_INVALID');
  }
  return path;
}

function validatedDatabaseURL(value) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PLAYWRIGHT_DATABASE_URL_INVALID');
  }
  let name;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  } catch {
    fail('PLAYWRIGHT_DATABASE_URL_INVALID');
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') ||
    parsed.username.length === 0 ||
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0 ||
    !/^spott_ci_[a-f0-9]{32}_test$/u.test(name)
  ) {
    fail('PLAYWRIGHT_DATABASE_URL_INVALID');
  }
  return value;
}

function validatedOutputPath(value) {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || value.includes('\u0000') || value.includes('\n')) {
    fail('PLAYWRIGHT_OUTPUT_PATH_INVALID');
  }
  const evidenceRoot = resolve(process.cwd(), 'output', 'playwright', 'core-journey');
  const candidate = resolve(value);
  const withinRoot = relative(evidenceRoot, candidate);
  if (
    withinRoot === '' ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot) ||
    !/^[a-f0-9]{32}$/u.test(withinRoot)
  ) {
    fail('PLAYWRIGHT_OUTPUT_PATH_INVALID');
  }
  let current = resolve(process.cwd());
  for (const component of relative(current, candidate).split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (!metadata) break;
    if (metadata.isSymbolicLink()) fail('PLAYWRIGHT_OUTPUT_PATH_INVALID');
  }
  return candidate;
}

function childEnvironment(attestation) {
  const environment = {
    NODE_ENV: 'test',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    SPOTT_PLAYWRIGHT_RUNTIME_ATTESTATION: attestation,
  };
  for (const key of [
    'CI',
    'FORCE_COLOR',
    'HOME',
    'NO_COLOR',
    'PATH',
    'PLAYWRIGHT_BASE_URL',
    'SPOTT_API_BASE_URL',
    'SPOTT_OPS_BASE_URL',
    'SPOTT_WEB_BASE_URL',
    'TERM',
    'TMPDIR',
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const databaseURL = validatedDatabaseURL(process.env.SPOTT_TEST_DATABASE_URL);
  if (databaseURL !== undefined) environment.SPOTT_TEST_DATABASE_URL = databaseURL;
  const outputPath = validatedOutputPath(process.env.SPOTT_E2E_OUTPUT_DIR);
  if (outputPath !== undefined) environment.SPOTT_E2E_OUTPUT_DIR = outputPath;
  return environment;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const before = await verifyPlaywrightRuntime(options);
  const cli = playwrightCLI(options.packagePath);
  const child = spawnSync(
    process.execPath,
    [cli, 'test', '--config=playwright.config.ts', ...(options.mode === 'list' ? ['--list'] : [])],
    {
      cwd: process.cwd(),
      env: childEnvironment(before.attestation),
      stdio: 'inherit',
    },
  );
  const after = await verifyPlaywrightRuntime(options);
  if (
    after.attestation !== before.attestation ||
    after.chromiumPath !== before.chromiumPath ||
    after.ffmpegPath !== before.ffmpegPath
  ) {
    fail('PLAYWRIGHT_RUNTIME_CHANGED');
  }
  if (child.error || child.signal || child.status !== 0) {
    fail('PLAYWRIGHT_TEST_FAILED');
  }
  process.stdout.write(`VERIFIED_PLAYWRIGHT_OK mode=${options.mode}\n`);
} catch (error) {
  const code =
    error instanceof Error && /^PLAYWRIGHT_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'PLAYWRIGHT_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
