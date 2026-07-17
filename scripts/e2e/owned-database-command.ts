import { spawn } from 'node:child_process';

import {
  createPostgresDatabaseOwnershipCoordinator,
  type CreatePostgresDatabaseOwnershipCoordinatorInput,
  type DatabaseCleanupResult,
  type DatabaseProvisionResult,
} from './database-harness.js';
import { createDatabaseRunIdentity, type DatabaseRunIdentity } from './database-safety.js';

interface OwnershipCoordinator {
  provision(): Promise<DatabaseProvisionResult>;
  verifyReady(): Promise<{ databaseName: string }>;
  cleanup(): Promise<DatabaseCleanupResult>;
}

export interface OwnedDatabaseCommandInput {
  adminURL: string;
  command: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}

interface CommandInput {
  command: string;
  arguments_: string[];
  environment: NodeJS.ProcessEnv;
}

export interface OwnedDatabaseCommandDependencies {
  createIdentity(): DatabaseRunIdentity;
  createCoordinator(input: CreatePostgresDatabaseOwnershipCoordinatorInput): OwnershipCoordinator;
  runCommand(input: CommandInput): Promise<void>;
}

function runCommand({ command, arguments_, environment }: CommandInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`OWNED_DATABASE_COMMAND_FAILED:${code ?? signal ?? 'unknown'}`));
    });
  });
}

const productionDependencies: OwnedDatabaseCommandDependencies = {
  createIdentity: createDatabaseRunIdentity,
  createCoordinator: createPostgresDatabaseOwnershipCoordinator,
  runCommand,
};

export async function runOwnedDatabaseCommand(
  input: OwnedDatabaseCommandInput,
  dependencies: OwnedDatabaseCommandDependencies = productionDependencies,
): Promise<void> {
  const identity = dependencies.createIdentity();
  let target: URL;
  try {
    target = new URL(input.adminURL);
  } catch {
    throw new Error('DATABASE_ENDPOINT_INVALID');
  }
  target.pathname = `/${identity.databaseName}`;
  const targetURL = target.toString();
  const coordinator = dependencies.createCoordinator({
    adminURL: input.adminURL,
    targetURL,
    runId: identity.runId,
    runToken: identity.runToken,
  });

  await coordinator.provision();
  await coordinator.verifyReady();
  let commandFailure: unknown;
  try {
    const childEnvironment = { ...input.environment };
    for (const key of [
      'DATABASE_URL',
      'SPOTT_CI_ADMIN_DATABASE_URL',
      'SPOTT_DATABASE_ADMIN_URL',
      'SPOTT_DATABASE_OWNERSHIP_REQUIRED',
      'SPOTT_DATABASE_RUN_ID',
      'SPOTT_DATABASE_RUN_TOKEN',
      'SPOTT_PNPM_COMMAND',
      'SPOTT_TEST_DATABASE_URL',
    ]) {
      delete childEnvironment[key];
    }
    await dependencies.runCommand({
      command: input.command,
      arguments_: [...input.arguments],
      environment: {
        ...childEnvironment,
        SPOTT_TEST_DATABASE_URL: targetURL,
      },
    });
  } catch (error) {
    commandFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await coordinator.cleanup();
  } catch (error) {
    cleanupFailure = error;
  }

  if (commandFailure && cleanupFailure) {
    throw new AggregateError(
      [commandFailure, cleanupFailure],
      'OWNED_DATABASE_COMMAND_AND_CLEANUP_FAILED',
    );
  }
  if (commandFailure) throw commandFailure;
  if (cleanupFailure) throw cleanupFailure;
}
