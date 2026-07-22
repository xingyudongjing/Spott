import { isAbsolute, join } from 'node:path';

const postgresSocketPathMaximumBytes = 103;
const runIdPattern = /^[a-f0-9]{32}$/u;
const socketDirectoryPrefix = 'spott-pg-s-';
const candidateRunIdLengths = [32, 24, 16] as const;

export function resolvePostgresSocketDirectory(
  systemTemporaryDirectory: string,
  runId: string,
): string {
  if (!runIdPattern.test(runId)) throw new Error('POSTGRES_SOCKET_RUN_ID_INVALID');

  const baseDirectories = [...new Set([systemTemporaryDirectory, '/tmp'])];
  for (const baseDirectory of baseDirectories) {
    if (
      !isAbsolute(baseDirectory)
      || baseDirectory.includes('\u0000')
      || /\s/u.test(baseDirectory)
    ) continue;

    for (const runIdLength of candidateRunIdLengths) {
      const directory = join(
        baseDirectory,
        `${socketDirectoryPrefix}${runId.slice(0, runIdLength)}`,
      );
      const longestSocketPath = join(directory, '.s.PGSQL.65535');
      if (Buffer.byteLength(longestSocketPath) <= postgresSocketPathMaximumBytes) {
        return directory;
      }
    }
  }

  throw new Error('POSTGRES_SOCKET_PATH_TOO_LONG');
}
