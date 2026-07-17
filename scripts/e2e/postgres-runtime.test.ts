import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { assertPostgresRuntime, loadLockedPostgresRuntime } from './postgres-runtime.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const exactPostgis =
  'POSTGIS="3.6.3 3d12666" [EXTENSION] PGSQL="180" GEOS="3.14.1-CAPI-1.20.5" ' +
  'PROJ="9.7.1 NETWORK_ENABLED=OFF URL_ENDPOINT=https://cdn.proj.org USER_WRITABLE_DIRECTORY=/tmp" ' +
  'LIBXML="2.15.3" LIBJSON="0.18" LIBPROTOBUF="1.5.2" WAGYU="0.5.0 (Internal)"';

void test('loads the exact PostgreSQL/PostGIS runtime contract from the toolchain lock', () => {
  const locked = loadLockedPostgresRuntime(join(repositoryRoot, 'ci/toolchain-lock.json'));

  assert.equal(locked.serverVersion, '18.4');
  assert.equal(locked.postgis.postgisRevision, '3.6.3 3d12666');
  assert.equal(locked.postgis.pgsql, '180');
  assert.equal(locked.postgis.networkEnabled, 'OFF');
});

void test('accepts only the exact locked server and extension components', () => {
  const locked = loadLockedPostgresRuntime(join(repositoryRoot, 'ci/toolchain-lock.json'));
  assert.doesNotThrow(() =>
    assertPostgresRuntime({ serverVersion: '18.4', postgisFullVersion: exactPostgis }, locked),
  );
  assert.doesNotThrow(() =>
    assertPostgresRuntime(
      { serverVersion: '18.4 (Postgres.app)', postgisFullVersion: exactPostgis },
      locked,
    ),
  );
});

void test('rejects server drift and each extension component drift without echoing runtime output', async (t) => {
  const locked = loadLockedPostgresRuntime(join(repositoryRoot, 'ci/toolchain-lock.json'));
  await t.test('server version', () => {
    assert.throws(
      () =>
        assertPostgresRuntime({ serverVersion: '18.5', postgisFullVersion: exactPostgis }, locked),
      (error: unknown) =>
        error instanceof Error &&
        /POSTGRES_VERSION_MISMATCH/u.test(error.message) &&
        !error.message.includes(exactPostgis),
    );
  });

  for (const [label, changed] of [
    ['PostGIS', exactPostgis.replace('3.6.3 3d12666', '3.6.4 changed')],
    ['PGSQL', exactPostgis.replace('PGSQL="180"', 'PGSQL="181"')],
    ['GEOS', exactPostgis.replace('3.14.1-CAPI-1.20.5', '3.15.0-CAPI-1.21.0')],
    ['PROJ', exactPostgis.replace('PROJ="9.7.1 ', 'PROJ="9.8.0 ')],
    ['network', exactPostgis.replace('NETWORK_ENABLED=OFF', 'NETWORK_ENABLED=ON')],
    ['LIBXML', exactPostgis.replace('LIBXML="2.15.3"', 'LIBXML="2.16.0"')],
    ['LIBJSON', exactPostgis.replace('LIBJSON="0.18"', 'LIBJSON="0.19"')],
    ['protobuf', exactPostgis.replace('LIBPROTOBUF="1.5.2"', 'LIBPROTOBUF="1.6.0"')],
    ['WAGYU', exactPostgis.replace('WAGYU="0.5.0 (Internal)"', 'WAGYU="0.6.0"')],
  ] as const) {
    await t.test(label, () => {
      assert.throws(
        () => assertPostgresRuntime({ serverVersion: '18.4', postgisFullVersion: changed }, locked),
        (error: unknown) =>
          error instanceof Error &&
          /POSTGIS_RUNTIME_MISMATCH/u.test(error.message) &&
          !error.message.includes(changed),
      );
    });
  }
});
