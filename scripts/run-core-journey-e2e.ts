import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { createPostgresDatabaseOwnershipCoordinator } from './e2e/database-harness.js';
import { createDatabaseRunIdentity } from './e2e/database-safety.js';
import { probeHTTPStatus } from './e2e/http-readiness.js';
import { resolveLockedIOSDestination } from './e2e/ios-test-destination.js';
import { assertIsolatedTestDatabase } from '../tests/e2e/fixtures/core-journey.js';

type Mode = 'web' | 'ios';
type DatabaseMode = 'local-owned-cluster' | 'linux-service' | 'macos-pinned-distribution';

interface LocalClusterRuntime {
  binDirectory: string;
  dataDirectory: string;
  socketDirectory: string;
  port: number;
}

interface DatabaseRuntime {
  mode: DatabaseMode;
  adminURL: string;
  targetURL: string;
  localCluster?: LocalClusterRuntime;
}

const root = process.cwd();
const mode = parseMode(process.argv[2]);
if (process.argv.slice(3).some((argument) => argument !== '--')) {
  throw new Error('CORE_JOURNEY_ARGUMENTS_INVALID');
}
const databaseMode = parseDatabaseMode(process.env.SPOTT_E2E_DATABASE_MODE);
const databaseIdentity = createDatabaseRunIdentity();
const allocatedPorts = await findUniqueAvailablePorts(4);
if (allocatedPorts.length !== 4) throw new Error('LOOPBACK_PORT_ALLOCATION_FAILED');
const [localPostgresPort, apiPort, webPort, opsPort] = allocatedPorts as [
  number,
  number,
  number,
  number,
];
const databaseRuntime = await createDatabaseRuntime(databaseMode, localPostgresPort);
const databaseURL = databaseRuntime.targetURL;
const node24 = process.execPath;
const pnpm = process.env.SPOTT_PNPM_COMMAND ?? 'pnpm';
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const verifiedPlaywright = join(root, 'scripts', 'ci', 'run-verified-playwright.mjs');
const outputDirectory = join(root, 'output', 'playwright', 'core-journey', databaseIdentity.runId);
const derivedDataPath = join(tmpdir(), `spott-core-journey-e2e-derived-${databaseIdentity.runId}`);
const databaseCoordinator = createPostgresDatabaseOwnershipCoordinator({
  adminURL: databaseRuntime.adminURL,
  targetURL: databaseRuntime.targetURL,
  runId: databaseIdentity.runId,
  runToken: databaseIdentity.runToken,
});

assertIsolatedTestDatabase(databaseURL);

const sharedEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(apiPort),
  DATABASE_URL: databaseURL,
  SPOTT_TEST_DATABASE_URL: databaseURL,
  WEB_ORIGIN: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  OPS_ORIGIN: `http://127.0.0.1:${opsPort}`,
  ACCESS_TOKEN_SECRET: `e2e-access-${randomBytes(32).toString('hex')}`,
  REFRESH_TOKEN_SECRET: `e2e-refresh-${randomBytes(32).toString('hex')}`,
  FIELD_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
  LOOKUP_HMAC_PEPPER: `e2e-lookup-${randomBytes(24).toString('hex')}`,
  OTP_PROVIDER: 'console',
  APPLE_ENABLE_ONLINE_CHECKS: 'false',
  API_INTERNAL_URL: `http://127.0.0.1:${apiPort}/v1`,
  NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}/v1`,
  NEXT_PUBLIC_MAP_STYLE_URL: `http://127.0.0.1:${webPort}/__e2e-map-style.json`,
  SPOTT_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
  PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${webPort}`,
  SPOTT_WEB_BASE_URL: `http://127.0.0.1:${webPort}`,
  SPOTT_E2E_OUTPUT_DIR: outputDirectory,
  SPOTT_E2E_DATABASE_ORIGIN: databaseRuntime.mode,
};

let apiProcess: ChildProcess | undefined;
let webProcess: ChildProcess | undefined;
let postgresStarted = false;
let databaseProvisioned = false;
let localDataDirectoryCreated = false;
let localSocketDirectoryCreated = false;
let derivedDataDirectoryCreated = false;
let cleaningUp = false;
let cleanupPromise: Promise<void> | undefined;
const migrationEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: databaseURL,
  SPOTT_DATABASE_OWNERSHIP_REQUIRED: '1',
  SPOTT_DATABASE_ADMIN_URL: databaseRuntime.adminURL,
  SPOTT_DATABASE_RUN_ID: databaseIdentity.runId,
  SPOTT_DATABASE_RUN_TOKEN: databaseIdentity.runToken,
};

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await assertPortsAvailable([apiPort, webPort, opsPort]);

  try {
    if (databaseRuntime.localCluster) {
      await startLocalPostgres(databaseRuntime.localCluster);
    }
    await databaseCoordinator.provision();
    databaseProvisioned = true;

    await run(pnpm, ['db:migrate'], migrationEnvironment);
    await run(tsx, ['tests/e2e/fixtures/core-journey.ts'], sharedEnvironment);
    await run(pnpm, ['--filter', '@spott/api', 'build'], sharedEnvironment);
    await run(pnpm, ['--filter', '@spott/web', 'build'], sharedEnvironment);

    apiProcess = start('api', node24, ['services/api/dist/main.js'], sharedEnvironment);
    await waitForURL(`http://127.0.0.1:${apiPort}/v1/health`, 'API health');
    webProcess = start(
      'web',
      pnpm,
      ['--filter', '@spott/web', 'start', '--', '-p', String(webPort), '-H', '127.0.0.1'],
      sharedEnvironment,
    );
    await waitForURL(`http://127.0.0.1:${webPort}/discover`, 'Web discovery', 120_000);

    if (mode === 'web') {
      await run(
        node24,
        [
          verifiedPlaywright,
          '--lock',
          join(root, 'ci', 'toolchain-lock.json'),
          '--package-json',
          join(root, 'node_modules', '@playwright', 'test', 'package.json'),
          '--root-prefix',
          '/',
          '--mode',
          'test',
        ],
        sharedEnvironment,
      );
    } else {
      const destination = resolveLockedIOSDestination(
        process.env.SPOTT_IOS_SIMULATOR_DESTINATION,
        join(root, 'ci', 'toolchain-lock.json'),
      );
      await mkdir(derivedDataPath, { recursive: false, mode: 0o700 });
      derivedDataDirectoryCreated = true;
      await run(
        'xcodebuild',
        [
          '-project',
          'Spott.xcodeproj',
          '-scheme',
          'Spott',
          '-destination',
          destination,
          '-derivedDataPath',
          derivedDataPath,
          'test',
          '-only-testing:SpottUITests',
        ],
        sharedEnvironment,
      );
    }
  } finally {
    await cleanup();
  }
}

function parseMode(value: string | undefined): Mode {
  if (value === 'web' || value === 'ios') return value;
  throw new Error('Usage: tsx scripts/run-core-journey-e2e.ts <web|ios>');
}

function parseDatabaseMode(value: string | undefined): DatabaseMode {
  if (value === undefined) return 'local-owned-cluster';
  if (
    value === 'local-owned-cluster' ||
    value === 'linux-service' ||
    value === 'macos-pinned-distribution'
  ) {
    return value;
  }
  throw new Error('SPOTT_E2E_DATABASE_MODE_INVALID');
}

async function createDatabaseRuntime(
  selectedMode: DatabaseMode,
  localPort: number,
): Promise<DatabaseRuntime> {
  if (selectedMode === 'linux-service') {
    const suppliedAdminURL = process.env.SPOTT_E2E_ADMIN_DATABASE_URL;
    if (!suppliedAdminURL) throw new Error('SPOTT_E2E_ADMIN_DATABASE_URL_REQUIRED');
    const admin = new URL(suppliedAdminURL);
    const target = new URL(admin);
    target.pathname = `/${databaseIdentity.databaseName}`;
    return {
      mode: selectedMode,
      adminURL: admin.toString(),
      targetURL: target.toString(),
    };
  }

  const binDirectory = await resolvePostgresBin(selectedMode);
  const dataDirectory = join(tmpdir(), `spott-core-journey-e2e-pg-${databaseIdentity.runId}`);
  const socketDirectory = join(tmpdir(), `spott-core-journey-e2e-socket-${databaseIdentity.runId}`);
  const adminURL = `postgres://postgres@127.0.0.1:${localPort}/postgres`;
  const targetURL = `postgres://postgres@127.0.0.1:${localPort}/${databaseIdentity.databaseName}`;
  return {
    mode: selectedMode,
    adminURL,
    targetURL,
    localCluster: { binDirectory, dataDirectory, socketDirectory, port: localPort },
  };
}

async function resolvePostgresBin(selectedMode: DatabaseMode): Promise<string> {
  const override = process.env.SPOTT_POSTGRES_BIN;
  if (override) return validatePostgresBin(override);
  if (selectedMode === 'macos-pinned-distribution') {
    throw new Error('SPOTT_POSTGRES_BIN_REQUIRED_FOR_PINNED_MODE');
  }
  const pgConfig = process.env.SPOTT_PG_CONFIG_COMMAND ?? 'pg_config';
  const discovered = (await captureOutput(pgConfig, ['--bindir'])).trim();
  return validatePostgresBin(discovered);
}

async function validatePostgresBin(value: string): Promise<string> {
  if (!isAbsolute(value) || value.includes('\u0000') || value.includes('\n')) {
    throw new Error('POSTGRES_BIN_INVALID');
  }
  await Promise.all([access(join(value, 'initdb')), access(join(value, 'pg_ctl'))]);
  return value;
}

async function captureOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => reject(new Error('EXECUTABLE_DISCOVERY_FAILED')));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`EXECUTABLE_DISCOVERY_FAILED:${code ?? signal ?? 'unknown'}`));
    });
  });
}

async function startLocalPostgres(runtime: LocalClusterRuntime): Promise<void> {
  assertOwnedTemporaryPath(runtime.dataDirectory, 'spott-core-journey-e2e-pg-');
  assertOwnedTemporaryPath(runtime.socketDirectory, 'spott-core-journey-e2e-socket-');
  if (/\s/u.test(runtime.socketDirectory)) throw new Error('POSTGRES_SOCKET_PATH_UNSAFE');
  await assertPortsAvailable([runtime.port]);
  await mkdir(runtime.dataDirectory, { recursive: false, mode: 0o700 });
  localDataDirectoryCreated = true;
  await mkdir(runtime.socketDirectory, { recursive: false, mode: 0o700 });
  localSocketDirectoryCreated = true;
  await run(join(runtime.binDirectory, 'initdb'), [
    '-D',
    runtime.dataDirectory,
    '--encoding=UTF8',
    '--no-locale',
    '--username=postgres',
    '--auth=trust',
  ]);
  await run(join(runtime.binDirectory, 'pg_ctl'), [
    '-D',
    runtime.dataDirectory,
    '-o',
    `-p ${runtime.port} -h 127.0.0.1 -k ${runtime.socketDirectory}`,
    '-w',
    'start',
  ]);
  postgresStarted = true;
}

function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  console.info(`\n[e2e] ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

function start(
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  console.info(`\n[e2e] starting ${label}`);
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    detached: true,
    shell: false,
  });
  child.once('exit', (code, signal) => {
    if (!cleaningUp) {
      console.error(`[e2e] ${label} stopped unexpectedly (${code ?? signal ?? 'unknown'})`);
    }
  });
  return child;
}

async function waitForURL(url: string, label: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    const result = await probeHTTPStatus(url);
    if (result.status !== undefined) {
      lastStatus = `HTTP ${result.status}`;
      if (result.status >= 200 && result.status < 400) {
        console.info(`[e2e] ${label} ready (${lastStatus})`);
        return;
      }
    } else {
      lastStatus = result.error ?? 'unknown probe error';
    }
    await delay(500);
  }
  throw new Error(`${label} did not become ready: ${lastStatus}`);
}

async function findUniqueAvailablePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await findAvailableLoopbackPort());
  return [...ports];
}

function findAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('LOOPBACK_PORT_ALLOCATION_FAILED'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function assertPortsAvailable(ports: number[]): Promise<void> {
  const occupied = (
    await Promise.all(
      ports.map(async (port) => ({
        port,
        open: await portIsOpen(port),
      })),
    )
  ).filter((entry) => entry.open);
  if (occupied.length) {
    throw new Error(
      `Core journey E2E requires isolated ports; already in use: ${occupied
        .map(({ port }) => port)
        .join(', ')}`,
    );
  }
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function cleanup(): Promise<void> {
  if (!cleanupPromise) {
    cleaningUp = true;
    cleanupPromise = performCleanup();
  }
  await cleanupPromise;
}

async function performCleanup(): Promise<void> {
  const failures: unknown[] = [];
  for (const processToStop of [webProcess, apiProcess]) {
    try {
      await terminate(processToStop);
    } catch (error) {
      failures.push(error);
    }
  }
  if (databaseProvisioned) {
    try {
      await databaseCoordinator.cleanup();
      databaseProvisioned = false;
    } catch (error) {
      failures.push(error);
    }
  }
  const localCluster = databaseRuntime.localCluster;
  if (postgresStarted && localCluster) {
    try {
      await run(join(localCluster.binDirectory, 'pg_ctl'), [
        '-D',
        localCluster.dataDirectory,
        '-m',
        'fast',
        '-w',
        'stop',
      ]);
      postgresStarted = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (localDataDirectoryCreated && localCluster) {
    try {
      assertOwnedTemporaryPath(localCluster.dataDirectory, 'spott-core-journey-e2e-pg-');
      await rm(localCluster.dataDirectory, { recursive: true, force: false });
      localDataDirectoryCreated = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (localSocketDirectoryCreated && localCluster) {
    try {
      assertOwnedTemporaryPath(localCluster.socketDirectory, 'spott-core-journey-e2e-socket-');
      await rm(localCluster.socketDirectory, { recursive: true, force: false });
      localSocketDirectoryCreated = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (derivedDataDirectoryCreated) {
    try {
      assertOwnedTemporaryPath(derivedDataPath, 'spott-core-journey-e2e-derived-');
      await rm(derivedDataPath, { recursive: true, force: false });
      derivedDataDirectoryCreated = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'CORE_JOURNEY_CLEANUP_FAILED');
  }
}

function assertOwnedTemporaryPath(path: string, prefix: string): void {
  const expected = join(tmpdir(), `${prefix}${databaseIdentity.runId}`);
  if (path !== expected) throw new Error('E2E_TEMPORARY_PATH_NOT_OWNED');
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exitAfterCleanup(code: number): void {
  void cleanup().then(
    () => process.exit(code),
    () => process.exit(1),
  );
}

process.once('SIGINT', () => exitAfterCleanup(130));
process.once('SIGTERM', () => exitAfterCleanup(143));

await main();
