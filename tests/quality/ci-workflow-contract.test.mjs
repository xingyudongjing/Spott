import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const workflowDirectory = join(repositoryRoot, '.github/workflows');
const requiredWorkflowNames = ['ci.yml', 'ios.yml'];
const expectedWorkflowNames = [...requiredWorkflowNames, 'nightly.yml', 'security-report.yml'];
const requiredChecks = readContract('required-pr-checks.json');
const scheduledChecks = readContract('scheduled-checks.json');

function readContract(name) {
  const contract = JSON.parse(readFileSync(join(import.meta.dirname, name), 'utf8'));
  assert.deepEqual(Object.keys(contract).sort(), ['checks', 'schemaVersion']);
  assert.equal(contract.schemaVersion, 1);
  assert.ok(Array.isArray(contract.checks));
  assert.equal(new Set(contract.checks).size, contract.checks.length);
  return contract.checks;
}

function workflowPath(name) {
  return join(workflowDirectory, name);
}

function readWorkflow(name) {
  const path = workflowPath(name);
  assert.equal(existsSync(path), true, `missing required workflow ${name}`);
  const metadata = lstatSync(path);
  assert.equal(metadata.isFile(), true, `${name} must be a regular file`);
  assert.equal(metadata.isSymbolicLink(), false, `${name} must not be a symlink`);
  const source = readFileSync(path, 'utf8');
  let parsed;
  assert.doesNotThrow(() => {
    parsed = yaml.load(source, { json: true });
  }, `${name} must parse as YAML`);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  assert.ok(parsed.jobs && typeof parsed.jobs === 'object' && !Array.isArray(parsed.jobs));
  return { name, path, source, parsed };
}

function eventNames(workflow) {
  const trigger = workflow.parsed.on;
  assert.ok(trigger && typeof trigger === 'object' && !Array.isArray(trigger));
  return Object.keys(trigger).sort();
}

function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, [...path, index]));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => walk(entry, visitor, [...path, key]));
  }
}

function allJobs(workflow) {
  return Object.entries(workflow.parsed.jobs).map(([id, job]) => ({ id, job }));
}

function allSteps(workflow) {
  return allJobs(workflow).flatMap(({ id, job }) =>
    (job.steps ?? []).map((step, index) => ({ jobId: id, index, step })),
  );
}

function normalizedIf(value) {
  return String(value ?? '')
    .replaceAll(/\$\{\{|\}\}/gu, '')
    .replaceAll(/\s+/gu, '')
    .toLowerCase();
}

function checkNames(workflows) {
  return workflows.flatMap((workflow) =>
    allJobs(workflow).map(({ id, job }) => ({
      workflow: workflow.name,
      id,
      name: job.name,
      job,
    })),
  );
}

test('repository contains the complete strict-YAML workflow set', () => {
  for (const name of expectedWorkflowNames) readWorkflow(name);
});

test('required and scheduled check contracts are exact and stable', () => {
  assert.deepEqual(requiredChecks, [
    'contracts-generated',
    'node-quality',
    'postgres-integration',
    'web-core-journey',
    'security-supply-chain',
    'ios-unit-release',
    'ios-ui-core-journey',
  ]);
  assert.deepEqual(scheduledChecks, [
    'nightly-load-concurrency',
    'nightly-accessibility-performance',
    'nightly-backup-restore',
  ]);
});

test('workflow triggers are exact, capability-ready, and never path-filtered', () => {
  const ci = readWorkflow('ci.yml');
  const ios = readWorkflow('ios.yml');
  const nightly = readWorkflow('nightly.yml');
  const security = readWorkflow('security-report.yml');

  for (const workflow of [ci, ios]) {
    assert.deepEqual(eventNames(workflow), [
      'merge_group',
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    assert.deepEqual(workflow.parsed.on.push.branches, ['main']);
  }
  assert.deepEqual(eventNames(nightly), ['schedule', 'workflow_dispatch']);
  assert.ok(Array.isArray(nightly.parsed.on.schedule));
  assert.ok(nightly.parsed.on.schedule.length > 0);
  assert.deepEqual(eventNames(security), ['push', 'workflow_dispatch']);
  assert.deepEqual(security.parsed.on.push.branches, ['main']);

  for (const workflow of [ci, ios, nightly, security]) {
    walk(workflow.parsed.on, (_value, path) => {
      const key = path.at(-1);
      assert.notEqual(key, 'paths', `${workflow.name} must not use paths filters`);
      assert.notEqual(key, 'paths-ignore', `${workflow.name} must not use paths-ignore filters`);
    });
  }
});

test('required aggregators are non-matrix, bounded, and fail closed over every need', () => {
  const workflows = requiredWorkflowNames.map(readWorkflow);
  const names = checkNames(workflows);
  const aggregators = requiredChecks.map((expectedName) => {
    const matches = names.filter(({ name }) => name === expectedName);
    assert.equal(matches.length, 1, `expected one stable aggregator named ${expectedName}`);
    return matches[0];
  });

  for (const { workflow, id, job } of aggregators) {
    assert.equal(job.strategy, undefined, `${workflow}:${id} aggregator must not use a matrix`);
    assert.equal(normalizedIf(job.if), 'always()', `${workflow}:${id} must use if: always()`);
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0);
    assert.ok(Array.isArray(job.needs) && job.needs.length > 0);
    assert.ok(Array.isArray(job.steps) && job.steps.length > 0);
    const serialized = JSON.stringify(job);
    assert.match(serialized, /toJSON\(needs\)|toJson\(needs\)/u);
    assert.match(serialized, /scripts\/ci\/verify-aggregator\.mjs/u);
    assert.match(serialized, /artifact-manifest/u);
  }
});

test('scheduled checks are exact, bounded, non-cancelling, and never branch-required', () => {
  const nightly = readWorkflow('nightly.yml');
  const names = checkNames([nightly]);
  assert.deepEqual(names.map(({ name }) => name).sort(), [...scheduledChecks].sort());
  for (const { id, job } of names) {
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0, id);
    assert.equal(job['continue-on-error'], undefined, id);
  }
  assert.notEqual(nightly.parsed.concurrency?.['cancel-in-progress'], true);
  for (const name of scheduledChecks) assert.equal(requiredChecks.includes(name), false);
});

test('permissions, checkout, event transfer, and execution are fork-safe', () => {
  const workflows = expectedWorkflowNames.map(readWorkflow);
  for (const workflow of workflows) {
    const expectedPermissions =
      workflow.name === 'security-report.yml'
        ? { contents: 'read', 'security-events': 'write' }
        : { contents: 'read' };
    assert.deepEqual(workflow.parsed.permissions, expectedPermissions, workflow.name);
    assert.equal(workflow.source.includes('pull_request_target'), false, workflow.name);
    assert.equal(workflow.source.includes('${{ secrets.'), false, workflow.name);

    for (const { id, job } of allJobs(workflow)) {
      assert.equal(
        job.environment,
        undefined,
        `${workflow.name}:${id} must not use an environment`,
      );
      if (requiredWorkflowNames.includes(workflow.name)) {
        assert.equal(
          job.permissions,
          undefined,
          `${workflow.name}:${id} must inherit read-only permissions`,
        );
      }
    }

    for (const { jobId, index, step } of allSteps(workflow)) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(
          step.with?.['persist-credentials'],
          false,
          `${workflow.name}:${jobId}:${index}`,
        );
      }
      if (typeof step.run === 'string') {
        assert.doesNotMatch(
          step.run,
          /\$\{\{\s*github\.(?:event|head_ref|ref_name|base_ref)/u,
          `${workflow.name}:${jobId}:${index} interpolates event data into shell`,
        );
      }
    }
  }

  for (const name of requiredWorkflowNames) {
    const workflow = readWorkflow(name);
    assert.ok(workflow.parsed.concurrency);
    assert.equal(workflow.parsed.concurrency['cancel-in-progress'], true);
    assert.match(String(workflow.parsed.concurrency.group), /github\.workflow/u);
  }
});

test('all third-party actions and service containers are immutable', () => {
  for (const workflow of expectedWorkflowNames.map(readWorkflow)) {
    for (const { jobId, index, step } of allSteps(workflow)) {
      if (typeof step.uses !== 'string' || step.uses.startsWith('./')) continue;
      assert.match(
        step.uses,
        /^[^\s@]+@[a-f0-9]{40}$/u,
        `${workflow.name}:${jobId}:${index} action must use a full commit SHA`,
      );
      assert.doesNotMatch(step.uses, /^actions\/cache@/u);
    }
    for (const { id, job } of allJobs(workflow)) {
      for (const service of Object.values(job.services ?? {})) {
        assert.match(
          String(service.image),
          /^[^\s@]+@sha256:[a-f0-9]{64}$/u,
          `${workflow.name}:${id} service image must be digest-pinned`,
        );
      }
    }
  }
});

test('required workflows verify the lock, install frozen, force execution, and use bundled Chromium', () => {
  const source = requiredWorkflowNames.map((name) => readWorkflow(name).source).join('\n');
  assert.match(source, /scripts\/ci\/verify-toolchain-lock\.mjs/u);
  assert.match(source, /ci\/toolchain-lock\.json/u);
  assert.match(source, /pnpm install --frozen-lockfile/u);
  assert.match(source, /--force/u);
  assert.match(readWorkflow('ci.yml').source, /PLAYWRIGHT_BROWSERS_PATH/u);
  assert.doesNotMatch(source, /playwright install/u);
});

test('workflows reject suppression, mutable releases, deployments, and privileged mutation', () => {
  const forbidden = [
    /continue-on-error/u,
    /\|\|\s*true/u,
    /set\s+\+e/u,
    /npm\s+publish/u,
    /gh\s+release/u,
    /docker\s+(?:push|buildx\s+build[^\n]*--push)/u,
    /xcodebuild[^\n]*(?:-exportArchive|-allowProvisioningUpdates)/u,
    /(?:fastlane|altool|notarytool|transporter)[^\n]*(?:upload|submit)/iu,
    /app-store|appstoreconnect/iu,
    /provider[^\n]*(?:send|refund|purchase)/iu,
    /gh\s+issue/u,
  ];
  for (const workflow of expectedWorkflowNames.map(readWorkflow)) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(workflow.source, pattern, `${basename(workflow.path)}: ${pattern}`);
    }
  }
});

test('artifact uploads fail on absence and retain bounded SHA manifests', () => {
  for (const workflow of expectedWorkflowNames.map(readWorkflow)) {
    const expectedRetention = workflow.name === 'nightly.yml' ? 14 : 7;
    for (const { jobId, index, step } of allSteps(workflow)) {
      if (!step.uses?.startsWith('actions/upload-artifact@')) continue;
      assert.equal(step.with?.['if-no-files-found'], 'error', `${workflow.name}:${jobId}:${index}`);
      assert.equal(
        step.with?.['retention-days'],
        expectedRetention,
        `${workflow.name}:${jobId}:${index}`,
      );
      assert.match(String(step.with?.path ?? ''), /manifest|sha256/iu);
    }
  }
});
