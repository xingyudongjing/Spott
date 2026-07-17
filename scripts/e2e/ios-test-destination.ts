import { readFileSync } from 'node:fs';

interface LockedIOSRuntime {
  version: string;
  build: string;
  identifier: string;
}

const versionPattern = /^[0-9]+(?:\.[0-9]+){1,3}$/u;
const buildPattern = /^[A-Za-z0-9.]+$/u;
const deviceNamePattern = /^[A-Za-z0-9 _-]+$/u;

function loadLockedIOSRuntime(lockPath: string): LockedIOSRuntime {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    throw new Error('IOS_RUNTIME_LOCK_INVALID');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('IOS_RUNTIME_LOCK_INVALID');
  }
  const candidate = (parsed as Record<string, unknown>).iosSimulatorRuntime;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('IOS_RUNTIME_LOCK_INVALID');
  }
  const runtime = candidate as Record<string, unknown>;
  const keys = Object.keys(runtime).toSorted();
  if (keys.join('\u0000') !== ['build', 'identifier', 'version'].join('\u0000')) {
    throw new Error('IOS_RUNTIME_LOCK_INVALID');
  }
  const { version, build, identifier } = runtime;
  if (
    typeof version !== 'string' ||
    !versionPattern.test(version) ||
    typeof build !== 'string' ||
    !buildPattern.test(build) ||
    typeof identifier !== 'string' ||
    identifier !== `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll('.', '-')}`
  ) {
    throw new Error('IOS_RUNTIME_LOCK_INVALID');
  }
  return { version, build, identifier };
}

function validateDestination(destination: string, version: string): void {
  const entries = destination.split(',').map((entry) => entry.split('='));
  if (
    entries.length !== 3 ||
    entries.some(([key, value, ...extra]) => !key || !value || extra.length !== 0)
  ) {
    throw new Error('IOS_DESTINATION_RUNTIME_MISMATCH');
  }
  const fields = new Map(entries as [string, string][]);
  if (
    fields.size !== 3 ||
    fields.get('platform') !== 'iOS Simulator' ||
    fields.get('OS') !== version ||
    !deviceNamePattern.test(fields.get('name') ?? '')
  ) {
    throw new Error('IOS_DESTINATION_RUNTIME_MISMATCH');
  }
}

export function resolveLockedIOSDestination(
  requestedDestination: string | undefined,
  lockPath: string,
): string {
  const runtime = loadLockedIOSRuntime(lockPath);
  const destination =
    requestedDestination ?? `platform=iOS Simulator,OS=${runtime.version},name=iPhone 17 Pro`;
  validateDestination(destination, runtime.version);
  return destination;
}
