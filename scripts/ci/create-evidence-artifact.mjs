#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const checkPattern = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const statuses = new Set(['success', 'failure', 'cancelled', 'skipped']);

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || values.has(flag)) {
      fail('EVIDENCE_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  const required = ['--check', '--output-directory', '--status'];
  if (values.size !== required.length || required.some((flag) => !values.has(flag))) {
    fail('EVIDENCE_ARGUMENTS_INVALID');
  }
  return {
    check: values.get('--check'),
    outputDirectory: values.get('--output-directory'),
    status: values.get('--status'),
  };
}

function createEvidenceArtifact({ check, outputDirectory, status }) {
  if (!checkPattern.test(check)) fail('EVIDENCE_CHECK_INVALID');
  if (!statuses.has(status)) fail('EVIDENCE_STATUS_INVALID');

  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const report = `${JSON.stringify({ schemaVersion: 1, check, status })}\n`;
  const reportPath = join(outputDirectory, 'report.json');
  writeFileSync(reportPath, report, { flag: 'wx', mode: 0o600 });
  const digest = createHash('sha256').update(report).digest('hex');
  writeFileSync(join(outputDirectory, 'artifact-manifest.sha256'), `${digest}  report.json\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

try {
  createEvidenceArtifact(parseArguments(process.argv.slice(2)));
  process.stdout.write('EVIDENCE_ARTIFACT_OK\n');
} catch (error) {
  const code =
    error instanceof Error && /^EVIDENCE_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'EVIDENCE_INTERNAL_ERROR';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
