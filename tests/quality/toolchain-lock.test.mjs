import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const verifier = join(repositoryRoot, 'scripts/ci/verify-toolchain-lock.mjs');
const lockPath = join(repositoryRoot, 'ci/toolchain-lock.json');
const schemaPath = join(repositoryRoot, 'ci/toolchain-lock.schema.json');
const downloader = join(repositoryRoot, 'scripts/ci/download-verified-tool.sh');

function runVerifier({ lock = lockPath, root = repositoryRoot } = {}) {
  return spawnSync(
    process.execPath,
    [verifier, '--lock', lock, '--schema', schemaPath, '--repo-root', root],
    { encoding: 'utf8' },
  );
}

function baseLock() {
  return JSON.parse(readFileSync(lockPath, 'utf8'));
}

function writeMutatedLock(mutator) {
  const directory = mkdtempSync(join(tmpdir(), 'spott-toolchain-lock-'));
  const lock = structuredClone(baseLock());
  mutator(lock);
  const path = join(directory, 'toolchain-lock.json');
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function expectRejected(result, code) {
  assert.notEqual(result.status, 0, `expected verifier failure, stdout=${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`\\b${code}\\b`, 'u'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runDownloader(arguments_, environment = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', [downloader, ...arguments_], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function createTlsFixture(archiveBuilder) {
  const directory = mkdtempSync(join(tmpdir(), 'spott-downloader-'));
  const key = join(directory, 'server.key');
  const certificate = join(directory, 'server.crt');
  const openssl = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(openssl.status, 0, openssl.stderr);
  const archive = archiveBuilder(directory);
  const bytes = readFileSync(archive);
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(bytes.length),
      });
      response.end(bytes);
    },
  );
  return { directory, archive, certificate, server };
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return `https://127.0.0.1:${address.port}/fixture.tar.gz`;
}

async function close(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

test('repository toolchain lock and schema pass fail-closed verification', () => {
  const result = runVerifier();

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /TOOLCHAIN_LOCK_OK/u);
});

test('rejects semver ranges and mutable container references', async (t) => {
  await t.test('Node range', () => {
    const mutated = writeMutatedLock((lock) => {
      lock.node.version = '>=24 <25';
    });
    expectRejected(runVerifier({ lock: mutated }), 'EXACT_VERSION_REQUIRED');
  });

  await t.test('Playwright tag without manifest digest', () => {
    const mutated = writeMutatedLock((lock) => {
      lock.containers.playwright.reference = 'mcr.microsoft.com/playwright:v1.61.1-noble';
    });
    expectRejected(runVerifier({ lock: mutated }), 'IMMUTABLE_DIGEST_REQUIRED');
  });
});

test('rejects missing download integrity and unknown fields', async (t) => {
  await t.test('missing SHA-256', () => {
    const mutated = writeMutatedLock((lock) => {
      delete lock.downloads.k6.sha256;
    });
    expectRejected(runVerifier({ lock: mutated }), 'SCHEMA_INVALID');
  });

  await t.test('missing macOS signing metadata', () => {
    const mutated = writeMutatedLock((lock) => {
      delete lock.downloads.macosArm64PostgresPostgis.signature.teamIdentifier;
    });
    expectRejected(runVerifier({ lock: mutated }), 'SCHEMA_INVALID');
  });

  await t.test('unknown top-level field', () => {
    const mutated = writeMutatedLock((lock) => {
      lock.unreviewedMutableInput = true;
    });
    expectRejected(runVerifier({ lock: mutated }), 'SCHEMA_INVALID');
  });
});

test('rejects a missing repository-pinned local file', () => {
  const mutated = writeMutatedLock((lock) => {
    lock.localFiles[0].path = 'missing/Package.resolved';
  });

  expectRejected(runVerifier({ lock: mutated }), 'LOCAL_FILE_MISSING');
});

test('Java not_applicable sentinel fails when Java-family source appears', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'spott-java-sentinel-'));
  for (const entry of baseLock().localFiles) {
    const source = join(repositoryRoot, entry.path);
    const destination = join(fixtureRoot, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  mkdirSync(join(fixtureRoot, 'fixture'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'fixture/Unexpected.java'), 'final class Unexpected {}\n', {
    mode: 0o600,
  });

  expectRejected(runVerifier({ root: fixtureRoot }), 'JAVA_LOCK_REQUIRED');
});

test('verified downloader enforces HTTPS, integrity, safe extraction, and quiet output', async (t) => {
  await t.test('rejects plain HTTP before network access', async () => {
    const result = await runDownloader([
      '--url',
      'http://127.0.0.1/tool.tar.gz',
      '--sha256',
      '0'.repeat(64),
      '--bytes',
      '1',
      '--archive-format',
      'tar.gz',
      '--destination',
      mkdtempSync(join(tmpdir(), 'spott-http-reject-')),
    ]);
    expectRejected(result, 'HTTPS_REQUIRED');
  });

  await t.test('downloads and extracts a reviewed regular-file archive', async () => {
    const fixture = createTlsFixture((directory) => {
      const input = join(directory, 'input');
      mkdirSync(input);
      writeFileSync(join(input, 'tool'), 'verified tool\n', { mode: 0o700 });
      const archive = join(directory, 'fixture.tar.gz');
      const tar = spawnSync('tar', ['-czf', archive, '-C', input, 'tool'], { encoding: 'utf8' });
      assert.equal(tar.status, 0, tar.stderr);
      return archive;
    });
    const destination = join(fixture.directory, 'output');
    mkdirSync(destination);
    const url = await listen(fixture.server);
    try {
      const result = await runDownloader(
        [
          '--url',
          url,
          '--sha256',
          sha256(fixture.archive),
          '--bytes',
          String(statSync(fixture.archive).size),
          '--archive-format',
          'tar.gz',
          '--destination',
          destination,
          '--ca-certificate',
          fixture.certificate,
        ],
        { SPOTT_DOWNLOADER_SECRET_SENTINEL: 'MUST_NOT_PRINT_7E86C' },
      );
      assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.equal(readFileSync(join(destination, 'tool'), 'utf8'), 'verified tool\n');
      assert.match(result.stdout, /^VERIFIED_DOWNLOAD_OK\n$/u);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /MUST_NOT_PRINT_7E86C/u);
    } finally {
      await close(fixture.server);
    }
  });

  await t.test('rejects a digest mismatch before extraction', async () => {
    const fixture = createTlsFixture((directory) => {
      const input = join(directory, 'input');
      mkdirSync(input);
      writeFileSync(join(input, 'tool'), 'wrong digest\n');
      const archive = join(directory, 'fixture.tar.gz');
      const tar = spawnSync('tar', ['-czf', archive, '-C', input, 'tool'], { encoding: 'utf8' });
      assert.equal(tar.status, 0, tar.stderr);
      return archive;
    });
    const destination = join(fixture.directory, 'output');
    mkdirSync(destination);
    const url = await listen(fixture.server);
    try {
      const result = await runDownloader([
        '--url',
        url,
        '--sha256',
        '0'.repeat(64),
        '--bytes',
        String(statSync(fixture.archive).size),
        '--archive-format',
        'tar.gz',
        '--destination',
        destination,
        '--ca-certificate',
        fixture.certificate,
      ]);
      expectRejected(result, 'HASH_MISMATCH');
      assert.equal(readdirSafe(destination).length, 0);
    } finally {
      await close(fixture.server);
    }
  });

  await t.test('rejects symlinks in an archive before extraction', async () => {
    const fixture = createTlsFixture((directory) => {
      const input = join(directory, 'input');
      mkdirSync(input);
      writeFileSync(join(input, 'real'), 'payload\n');
      symlinkSync('real', join(input, 'tool'));
      const archive = join(directory, 'fixture.tar.gz');
      const tar = spawnSync('tar', ['-czf', archive, '-C', input, 'tool'], { encoding: 'utf8' });
      assert.equal(tar.status, 0, tar.stderr);
      return archive;
    });
    const destination = join(fixture.directory, 'output');
    mkdirSync(destination);
    const url = await listen(fixture.server);
    try {
      const result = await runDownloader([
        '--url',
        url,
        '--sha256',
        sha256(fixture.archive),
        '--bytes',
        String(statSync(fixture.archive).size),
        '--archive-format',
        'tar.gz',
        '--destination',
        destination,
        '--ca-certificate',
        fixture.certificate,
      ]);
      expectRejected(result, 'UNSAFE_ARCHIVE');
      assert.equal(readdirSafe(destination).length, 0);
    } finally {
      await close(fixture.server);
    }
  });
});

function readdirSafe(path) {
  return readdirSync(path);
}
