import process from 'node:process';

import { runOwnedDatabaseCommand } from '../e2e/owned-database-command.js';

const adminURL = process.env.SPOTT_CI_ADMIN_DATABASE_URL;
if (!adminURL) throw new Error('SPOTT_CI_ADMIN_DATABASE_URL_REQUIRED');

const childEnvironment: NodeJS.ProcessEnv = {};
for (const key of ['CI', 'FORCE_COLOR', 'HOME', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR']) {
  const value = process.env[key];
  if (value !== undefined) childEnvironment[key] = value;
}

await runOwnedDatabaseCommand({
  adminURL,
  command: process.env.SPOTT_PNPM_COMMAND ?? 'pnpm',
  arguments: ['exec', 'tsx', 'scripts/test-postgis.ts', '--all'],
  environment: childEnvironment,
});
