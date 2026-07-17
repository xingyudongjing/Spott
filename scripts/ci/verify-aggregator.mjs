#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const needNamePattern = /^[a-z][a-z0-9_-]{0,79}$/u;
const artifactNamePattern = /^[a-z0-9][a-z0-9._-]{0,119}$/u;
const manifestLinePattern = /^(?<sha256>[a-f0-9]{64}) {2}(?<path>[A-Za-z0-9][A-Za-z0-9._/-]*)$/u;

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || values.has(flag)) {
      fail('AGGREGATOR_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  const expectedKeys = ['--artifacts-root', '--expected-needs', '--output-directory'];
  if (values.size !== expectedKeys.length || expectedKeys.some((key) => !values.has(key))) {
    fail('AGGREGATOR_ARGUMENTS_INVALID');
  }
  return {
    expectedNeeds: values.get('--expected-needs'),
    artifactsRoot: values.get('--artifacts-root'),
    outputDirectory: values.get('--output-directory'),
  };
}

function parseExpectedNeeds(value) {
  const names = value.split(',');
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    names.some((name) => !needNamePattern.test(name))
  ) {
    fail('AGGREGATOR_EXPECTED_NEEDS_INVALID');
  }
  return names;
}

function parseNeeds(expectedNeeds) {
  const source = process.env.SPOTT_NEEDS_JSON;
  if (!source || source.length > 1_000_000) fail('AGGREGATOR_NEEDS_INVALID');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('AGGREGATOR_NEEDS_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('AGGREGATOR_NEEDS_INVALID');
  }
  const actualNames = Object.keys(parsed).toSorted();
  const expectedNames = [...expectedNeeds].toSorted();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail('AGGREGATOR_NEEDS_SET_MISMATCH');
  }

  const artifactNames = new Map();
  for (const name of expectedNeeds) {
    const need = parsed[name];
    if (!need || typeof need !== 'object' || Array.isArray(need)) {
      fail('AGGREGATOR_NEEDS_INVALID');
    }
    if (need.result !== 'success') fail('AGGREGATOR_NEED_NOT_SUCCESS');
    const outputs = need.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
      fail('AGGREGATOR_ARTIFACT_NAME_INVALID');
    }
    const artifactName = outputs['artifact-name'];
    if (typeof artifactName !== 'string' || !artifactNamePattern.test(artifactName)) {
      fail('AGGREGATOR_ARTIFACT_NAME_INVALID');
    }
    if ([...artifactNames.values()].includes(artifactName)) {
      fail('AGGREGATOR_ARTIFACT_NAME_INVALID');
    }
    artifactNames.set(name, artifactName);
  }
  return artifactNames;
}

function assertSafeFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
    fail('AGGREGATOR_ARTIFACT_UNSAFE');
  }
}

function listArtifactFiles(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(directory).toSorted()) {
    const absolute = join(directory, name);
    const relative = prefix ? posix.join(prefix, name) : name;
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
      fail('AGGREGATOR_ARTIFACT_UNSAFE');
    }
    if (metadata.isDirectory()) {
      files.push(...listArtifactFiles(absolute, relative));
    } else if (metadata.isFile()) {
      files.push(relative);
    } else {
      fail('AGGREGATOR_ARTIFACT_UNSAFE');
    }
  }
  return files;
}

function parseManifest(directory) {
  const path = join(directory, 'artifact-manifest.sha256');
  assertSafeFile(path);
  const source = readFileSync(path, 'utf8');
  if (!source.endsWith('\n')) fail('AGGREGATOR_MANIFEST_INVALID');
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail('AGGREGATOR_MANIFEST_INVALID');
  }
  const entries = lines.map((line) => {
    const match = manifestLinePattern.exec(line);
    const relativePath = match?.groups?.path;
    if (
      !match?.groups?.sha256 ||
      !relativePath ||
      relativePath === 'artifact-manifest.sha256' ||
      relativePath.startsWith('/') ||
      relativePath.includes('\\') ||
      relativePath.split('/').includes('..') ||
      posix.normalize(relativePath) !== relativePath
    ) {
      fail('AGGREGATOR_MANIFEST_INVALID');
    }
    return { sha256: match.groups.sha256, path: relativePath };
  });
  const paths = entries.map((entry) => entry.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => path !== [...paths].toSorted()[index])
  ) {
    fail('AGGREGATOR_MANIFEST_INVALID');
  }
  return entries;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyArtifact(directory) {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
    fail('AGGREGATOR_ARTIFACT_UNSAFE');
  }
  // Inspect the complete tree before trusting any manifest bytes so unsafe
  // filesystem entries cannot be masked by an earlier manifest parse error.
  const actualFiles = listArtifactFiles(directory).filter(
    (path) => path !== 'artifact-manifest.sha256',
  );
  const manifest = parseManifest(directory);
  const expectedFiles = manifest.map((entry) => entry.path);
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((path, index) => path !== expectedFiles[index])
  ) {
    fail('AGGREGATOR_ARTIFACT_SET_MISMATCH');
  }
  for (const entry of manifest) {
    const path = join(directory, ...entry.path.split('/'));
    assertSafeFile(path);
    if (hashFile(path) !== entry.sha256) fail('AGGREGATOR_ARTIFACT_HASH_MISMATCH');
  }
}

function verifyArtifactsRoot(root, artifactNames) {
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('AGGREGATOR_ARTIFACT_UNSAFE');
  }
  const expectedDirectories = [...artifactNames.values()].toSorted();
  const actualDirectories = readdirSync(root).toSorted();
  if (
    actualDirectories.length !== expectedDirectories.length ||
    actualDirectories.some((name, index) => name !== expectedDirectories[index])
  ) {
    fail('AGGREGATOR_ARTIFACT_SET_MISMATCH');
  }
  for (const artifactName of expectedDirectories) verifyArtifact(join(root, artifactName));
}

function writeStatus(outputDirectory, expectedNeeds) {
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const status = `${JSON.stringify({
    schemaVersion: 1,
    status: 'success',
    needs: expectedNeeds,
  })}\n`;
  const statusPath = join(outputDirectory, 'aggregator-status.json');
  writeFileSync(statusPath, status, { mode: 0o600, flag: 'wx' });
  const digest = createHash('sha256').update(status).digest('hex');
  writeFileSync(
    join(outputDirectory, 'artifact-manifest.sha256'),
    `${digest}  aggregator-status.json\n`,
    { mode: 0o600, flag: 'wx' },
  );
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const expectedNeeds = parseExpectedNeeds(arguments_.expectedNeeds);
  const artifactNames = parseNeeds(expectedNeeds);
  verifyArtifactsRoot(arguments_.artifactsRoot, artifactNames);
  writeStatus(arguments_.outputDirectory, expectedNeeds);
  process.stdout.write(`AGGREGATOR_OK needs=${expectedNeeds.length}\n`);
} catch (error) {
  const code =
    error instanceof Error && /^AGGREGATOR_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'AGGREGATOR_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
