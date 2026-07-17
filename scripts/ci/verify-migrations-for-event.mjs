#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolveMigrationBaseSHA } from './migration-event-base.mjs';

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || values.has(flag)) {
      fail('MIGRATION_EVENT_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  const required = ['--event-name', '--event-path', '--head-sha', '--repo-root'];
  if (values.size !== required.length || required.some((flag) => !values.has(flag))) {
    fail('MIGRATION_EVENT_ARGUMENTS_INVALID');
  }
  const suppliedRoot = resolve(values.get('--repo-root'));
  const rootMetadata = lstatSync(suppliedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('MIGRATION_EVENT_INPUT_UNSAFE');
  }
  return {
    eventName: values.get('--event-name'),
    eventPath: resolve(values.get('--event-path')),
    headSHA: values.get('--head-sha'),
    repositoryRoot: realpathSync(suppliedRoot),
  };
}

function readEvent(path) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    statSync(path).size > 1_000_000
  ) {
    fail('MIGRATION_EVENT_INPUT_UNSAFE');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('MIGRATION_EVENT_INPUT_INVALID');
  }
}

function resolveParent(repositoryRoot, headSHA) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${headSHA}^`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail('MIGRATION_BASE_INVALID');
  return result.stdout.trim();
}

function verify(options) {
  const event = readEvent(options.eventPath);
  const baseSHA = resolveMigrationBaseSHA({
    eventName: options.eventName,
    event,
    headSHA: options.headSHA,
    resolveParent: (headSHA) => resolveParent(options.repositoryRoot, headSHA),
  });
  const result = spawnSync(
    process.execPath,
    [
      join(options.repositoryRoot, 'scripts/ci/verify-migration-manifest.mjs'),
      '--manifest',
      join(options.repositoryRoot, 'database/migration-manifest.json'),
      '--schema',
      join(options.repositoryRoot, 'database/migration-manifest.schema.json'),
      '--migrations-dir',
      join(options.repositoryRoot, 'database/migrations'),
      '--base-ref',
      baseSHA,
      '--repo-root',
      options.repositoryRoot,
    ],
    {
      cwd: options.repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.signal || result.status === null) {
    fail('MIGRATION_EVENT_VERIFIER_FAILED');
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status;
}

try {
  process.exitCode = verify(parseArguments(process.argv.slice(2)));
} catch (error) {
  const code =
    error instanceof Error && /^MIGRATION_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'MIGRATION_EVENT_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
