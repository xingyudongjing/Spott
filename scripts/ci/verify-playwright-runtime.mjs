#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  createReadStream,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256Pattern = /^[a-f0-9]{64}$/u;

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
  const required = ['--lock', '--package-json', '--root-prefix'];
  if (values.size !== required.length || required.some((flag) => !values.has(flag))) {
    fail('PLAYWRIGHT_ARGUMENTS_INVALID');
  }
  return {
    lockPath: resolve(values.get('--lock')),
    packagePath: resolve(values.get('--package-json')),
    rootPrefix: realpathSync(resolve(values.get('--root-prefix'))),
  };
}

function readJson(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
    fail('PLAYWRIGHT_INPUT_UNSAFE');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('PLAYWRIGHT_INPUT_INVALID');
  }
}

function binaryContract(lock, name) {
  const binary = lock?.containers?.playwright?.[name];
  if (
    !binary ||
    typeof binary.path !== 'string' ||
    !isAbsolute(binary.path) ||
    !Number.isSafeInteger(binary.bytes) ||
    binary.bytes <= 0 ||
    typeof binary.sha256 !== 'string' ||
    !sha256Pattern.test(binary.sha256)
  ) {
    fail('PLAYWRIGHT_LOCK_INVALID');
  }
  return binary;
}

function resolveContainerPath(rootPrefix, containerPath) {
  const candidate = resolve(rootPrefix, containerPath.slice(1));
  const pathWithinRoot = relative(rootPrefix, candidate);
  if (
    pathWithinRoot === '..' ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinRoot)
  ) {
    fail('PLAYWRIGHT_BINARY_UNSAFE');
  }
  let current = rootPrefix;
  for (const component of pathWithinRoot.split(sep)) {
    current = join(current, component);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) fail('PLAYWRIGHT_BINARY_UNSAFE');
  }
  const canonical = realpathSync(candidate);
  const canonicalWithinRoot = relative(rootPrefix, canonical);
  if (
    canonicalWithinRoot === '..' ||
    canonicalWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(canonicalWithinRoot)
  ) {
    fail('PLAYWRIGHT_BINARY_UNSAFE');
  }
  return canonical;
}

function assertNonReplaceableChain(rootPrefix, path) {
  const relativePath = relative(rootPrefix, path);
  const paths = [rootPrefix];
  let current = rootPrefix;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    paths.push(current);
  }
  const currentUser = process.getuid?.();
  if (currentUser === undefined || currentUser === 0) {
    fail('PLAYWRIGHT_BINARY_REPLACEABLE');
  }
  for (const candidate of paths) {
    const metadata = lstatSync(candidate);
    if (metadata.uid === currentUser) fail('PLAYWRIGHT_BINARY_REPLACEABLE');
    try {
      accessSync(candidate, constants.W_OK);
      fail('PLAYWRIGHT_BINARY_REPLACEABLE');
    } catch (error) {
      if (error instanceof Error && error.message === 'PLAYWRIGHT_BINARY_REPLACEABLE') throw error;
    }
  }
}

function assertSafeExecutable(path) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    fail('PLAYWRIGHT_BINARY_UNSAFE');
  }
}

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function verifyBinary(rootPrefix, contract) {
  const path = resolveContainerPath(rootPrefix, contract.path);
  assertSafeExecutable(path);
  const before = statSync(path);
  if (before.size !== contract.bytes) fail('PLAYWRIGHT_BINARY_MISMATCH');
  if ((await hashFile(path)) !== contract.sha256) fail('PLAYWRIGHT_BINARY_MISMATCH');
  const after = statSync(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    fail('PLAYWRIGHT_BINARY_MISMATCH');
  }
  assertNonReplaceableChain(rootPrefix, path);
  return path;
}

function runtimeAttestation(lock) {
  const runtime = lock.containers.playwright;
  return createHash('sha256')
    .update(
      [
        runtime.packageVersion,
        runtime.chromium.path,
        runtime.chromium.sha256,
        runtime.ffmpeg.path,
        runtime.ffmpeg.sha256,
      ].join('\u0000'),
    )
    .digest('hex');
}

export async function verifyPlaywrightRuntime(options) {
  const lock = readJson(options.lockPath);
  const packageMetadata = readJson(options.packagePath);
  const expectedVersion = lock?.containers?.playwright?.packageVersion;
  if (
    typeof expectedVersion !== 'string' ||
    typeof packageMetadata.version !== 'string' ||
    packageMetadata.version !== expectedVersion
  ) {
    fail('PLAYWRIGHT_PACKAGE_MISMATCH');
  }
  const chromiumPath = await verifyBinary(
    options.rootPrefix,
    binaryContract(lock, 'chromium'),
  );
  const ffmpegPath = await verifyBinary(options.rootPrefix, binaryContract(lock, 'ffmpeg'));
  return { chromiumPath, ffmpegPath, attestation: runtimeAttestation(lock) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyPlaywrightRuntime(parseArguments(process.argv.slice(2)));
    process.stdout.write('PLAYWRIGHT_RUNTIME_OK\n');
  } catch (error) {
    const code =
      error instanceof Error && /^PLAYWRIGHT_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'PLAYWRIGHT_INTERNAL_ERROR';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
