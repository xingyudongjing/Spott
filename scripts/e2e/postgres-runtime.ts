import { readFileSync } from 'node:fs';

export interface LockedPostgisRuntime {
  postgisRevision: string;
  pgsql: string;
  geos: string;
  proj: string;
  networkEnabled: 'ON' | 'OFF';
  libxml: string;
  libjson: string;
  libprotobuf: string;
  wagyu: string;
}

export interface LockedPostgresRuntime {
  serverVersion: string;
  postgis: LockedPostgisRuntime;
}

export interface ObservedPostgresRuntime {
  serverVersion: string;
  postgisFullVersion: string;
}

const postgresVersionPattern = /PostgreSQL\) (?<version>[0-9]+(?:\.[0-9]+){1,3})(?:\s|$)/u;
const observedPostgresVersionPattern = /^(?<version>[0-9]+(?:\.[0-9]+){1,3})(?:\s|$)/u;
const requiredPostgisKeys = [
  'postgisRevision',
  'pgsql',
  'geos',
  'proj',
  'networkEnabled',
  'libxml',
  'libjson',
  'libprotobuf',
  'wagyu',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failLock(): never {
  throw new Error('POSTGRES_RUNTIME_LOCK_INVALID');
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) failLock();
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) failLock();
  return value;
}

export function loadLockedPostgresRuntime(lockPath: string): LockedPostgresRuntime {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    failLock();
  }

  const root = requireRecord(parsed);
  const downloads = requireRecord(root.downloads);
  const macosRuntime = requireRecord(downloads.macosArm64PostgresPostgis);
  const expectedPostgresVersion = requireString(macosRuntime.expectedPostgresVersion);
  const versionMatch = postgresVersionPattern.exec(expectedPostgresVersion);
  if (!versionMatch?.groups?.version) failLock();

  const rawPostgis = requireRecord(macosRuntime.expectedPostgisFullVersion);
  const actualKeys = Object.keys(rawPostgis).toSorted();
  const expectedKeys = [...requiredPostgisKeys].toSorted();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    failLock();
  }

  const networkEnabled = rawPostgis.networkEnabled;
  if (networkEnabled !== 'ON' && networkEnabled !== 'OFF') failLock();

  return {
    serverVersion: versionMatch.groups.version,
    postgis: {
      postgisRevision: requireString(rawPostgis.postgisRevision),
      pgsql: requireString(rawPostgis.pgsql),
      geos: requireString(rawPostgis.geos),
      proj: requireString(rawPostgis.proj),
      networkEnabled,
      libxml: requireString(rawPostgis.libxml),
      libjson: requireString(rawPostgis.libjson),
      libprotobuf: requireString(rawPostgis.libprotobuf),
      wagyu: requireString(rawPostgis.wagyu),
    },
  };
}

export function assertPostgresRuntime(
  observed: ObservedPostgresRuntime,
  locked: LockedPostgresRuntime,
): void {
  const observedServerVersion = observedPostgresVersionPattern.exec(observed.serverVersion);
  if (observedServerVersion?.groups?.version !== locked.serverVersion) {
    throw new Error('POSTGRES_VERSION_MISMATCH');
  }

  const expectedComponents = [
    `POSTGIS="${locked.postgis.postgisRevision}"`,
    `PGSQL="${locked.postgis.pgsql}"`,
    `GEOS="${locked.postgis.geos}"`,
    `PROJ="${locked.postgis.proj} `,
    `NETWORK_ENABLED=${locked.postgis.networkEnabled}`,
    `LIBXML="${locked.postgis.libxml}"`,
    `LIBJSON="${locked.postgis.libjson}"`,
    `LIBPROTOBUF="${locked.postgis.libprotobuf}"`,
    `WAGYU="${locked.postgis.wagyu}"`,
  ];
  if (expectedComponents.some((component) => !observed.postgisFullVersion.includes(component))) {
    throw new Error('POSTGIS_RUNTIME_MISMATCH');
  }
}
