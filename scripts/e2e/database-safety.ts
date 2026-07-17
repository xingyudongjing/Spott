import { createHash, randomBytes } from 'node:crypto';

const runIdPattern = /^[a-f0-9]{32}$/u;
const runTokenPattern = /^[a-f0-9]{64}$/u;
const databaseNamePattern = /^spott_ci_[a-f0-9]{32}_test$/u;
const loopbackHosts = new Set(['127.0.0.1', '[::1]']);

export interface DatabaseRunIdentity {
  runId: string;
  runToken: string;
  tokenHash: string;
  databaseName: string;
}

export interface ValidateDatabaseEndpointsInput {
  adminURL: string;
  targetURL: string;
  runId: string;
  runToken: string;
}

export interface ValidatedDatabaseEndpoints {
  databaseName: string;
  adminDatabaseName: string;
  host: string;
  port: number;
  tokenHash: string;
}

export function hashRunToken(runToken: string): string {
  if (!runTokenPattern.test(runToken)) {
    throw new Error('DATABASE_RUN_TOKEN_INVALID: ownership token must contain 32 random bytes');
  }
  return createHash('sha256').update(runToken, 'ascii').digest('hex');
}

export function createDatabaseRunIdentity(): DatabaseRunIdentity {
  const runId = randomBytes(16).toString('hex');
  const runToken = randomBytes(32).toString('hex');
  return {
    runId,
    runToken,
    tokenHash: hashRunToken(runToken),
    databaseName: `spott_ci_${runId}_test`,
  };
}

function parsePostgresURL(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`DATABASE_ENDPOINT_INVALID: ${label} URL is malformed`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_ENDPOINT_INVALID: ${label} must use PostgreSQL`);
  }
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error(`DATABASE_ENDPOINT_NOT_LOCAL: ${label} is not an exact loopback address`);
  }
  if (parsed.search.length !== 0 || parsed.hash.length !== 0) {
    throw new Error(
      `DATABASE_ENDPOINT_AMBIGUOUS: ${label} must not contain query or fragment data`,
    );
  }
  if (parsed.username.length === 0) {
    throw new Error(`DATABASE_ENDPOINT_INVALID: ${label} must name an explicit database user`);
  }
  const port = parsed.port.length === 0 ? 5432 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`DATABASE_ENDPOINT_INVALID: ${label} port is invalid`);
  }
  return parsed;
}

function databaseName(parsed: URL, label: string): string {
  const encoded = parsed.pathname.replace(/^\//u, '');
  if (encoded.length === 0 || encoded.includes('/')) {
    throw new Error(`DATABASE_ENDPOINT_INVALID: ${label} database name is missing or ambiguous`);
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error(`DATABASE_ENDPOINT_INVALID: ${label} database name is malformed`);
  }
}

function endpointAuthority(parsed: URL): string {
  const port = parsed.port.length === 0 ? '5432' : parsed.port;
  return [parsed.protocol, parsed.hostname, port, parsed.username, parsed.password].join('\u0000');
}

export function validateDatabaseEndpoints({
  adminURL,
  targetURL,
  runId,
  runToken,
}: ValidateDatabaseEndpointsInput): ValidatedDatabaseEndpoints {
  if (!runIdPattern.test(runId)) {
    throw new Error('DATABASE_RUN_ID_INVALID: run ID must contain 16 random bytes');
  }
  const tokenHash = hashRunToken(runToken);
  const expectedDatabaseName = `spott_ci_${runId}_test`;
  const admin = parsePostgresURL(adminURL, 'admin');
  const target = parsePostgresURL(targetURL, 'target');
  if (endpointAuthority(admin) !== endpointAuthority(target)) {
    throw new Error(
      'DATABASE_ENDPOINT_MISMATCH: admin and target must use the same local endpoint',
    );
  }
  const adminDatabaseName = databaseName(admin, 'admin');
  const targetDatabaseName = databaseName(target, 'target');
  if (adminDatabaseName !== 'postgres') {
    throw new Error('DATABASE_ENDPOINT_INVALID: admin connection must use the postgres database');
  }
  if (
    targetDatabaseName !== expectedDatabaseName ||
    !databaseNamePattern.test(targetDatabaseName) ||
    targetDatabaseName === adminDatabaseName
  ) {
    throw new Error(
      'DATABASE_NAME_NOT_OWNED: target does not match the current unpredictable run ID',
    );
  }
  return {
    databaseName: targetDatabaseName,
    adminDatabaseName,
    host: target.hostname,
    port: target.port.length === 0 ? 5432 : Number(target.port),
    tokenHash,
  };
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!databaseNamePattern.test(identifier)) {
    throw new Error('DATABASE_IDENTIFIER_INVALID: identifier is not an owned test database name');
  }
  return `"${identifier}"`;
}
