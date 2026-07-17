#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const outputDirectories = [
  '.turbo',
  'DerivedData',
  'apps/ops/.next',
  'apps/ops/dist',
  'apps/web/.next',
  'apps/web/dist',
  'output',
  'packages/api-client/dist',
  'packages/contracts/dist',
  'packages/domain/dist',
  'packages/ui/dist',
  'services/api/dist',
  'services/worker/dist',
].toSorted();

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--repo-root' || !argv[1]) {
    fail('REQUIRED_JOB_ARGUMENTS_INVALID');
  }
  const suppliedRoot = resolve(argv[1]);
  const metadata = lstatSync(suppliedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('REQUIRED_JOB_ROOT_UNSAFE');
  }
  return realpathSync(suppliedRoot);
}

function assertWithinRoot(root, path) {
  const pathWithinRoot = relative(root, path);
  if (
    pathWithinRoot === '..' ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinRoot)
  ) {
    fail('REQUIRED_JOB_OUTPUT_UNSAFE');
  }
}

function assertPathComponentsSafe(root, relativePath) {
  let current = root;
  for (const component of relativePath.split('/')) {
    current = join(current, component);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (!metadata) return;
    if (metadata.isSymbolicLink()) fail('REQUIRED_JOB_OUTPUT_UNSAFE');
  }
}

function assertTreeSafe(directory) {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('REQUIRED_JOB_OUTPUT_UNSAFE');
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const child = lstatSync(path);
    if (child.isSymbolicLink()) fail('REQUIRED_JOB_OUTPUT_UNSAFE');
    if (child.isDirectory()) assertTreeSafe(path);
    else if (!child.isFile()) fail('REQUIRED_JOB_OUTPUT_UNSAFE');
  }
}

function prepare(root) {
  let removed = 0;
  for (const relativePath of outputDirectories) {
    assertPathComponentsSafe(root, relativePath);
    const directory = resolve(root, relativePath);
    assertWithinRoot(root, directory);
    const metadata = lstatSync(directory, { throwIfNoEntry: false });
    if (!metadata) continue;
    assertTreeSafe(directory);
    rmSync(directory, { recursive: true, force: false });
    removed += 1;
  }
  return removed;
}

try {
  const removed = prepare(parseArguments(process.argv.slice(2)));
  process.stdout.write(`REQUIRED_JOB_PREPARED removed=${removed}\n`);
} catch (error) {
  const code =
    error instanceof Error && /^REQUIRED_JOB_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'REQUIRED_JOB_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
