import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer as createHTTPServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseVersionedKeyring } from '../../config.js';
import { signBFFAuthority } from '../../platform/web-bff-authority.js';

type SessionTransportClass = 'web_bff' | 'native' | 'ops' | 'legacy_unclassified';
type WebSessionBFFEnforcement = 'off' | 'observe' | 'enforce';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const accessSecret = 'task3-access-token-secret-at-least-32-bytes';
const refreshSecretKey = 'task3-refresh-token-secret-at-least-32-bytes';
const bffKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const derivationKey = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA';
const bffKid = 'bff-2026-07';
const apiRoot = resolve(import.meta.dirname, '../../..');
const execFileAsync = promisify(execFile);

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseURL,
  ACCESS_TOKEN_SECRET: accessSecret,
  REFRESH_TOKEN_SECRET: refreshSecretKey,
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'task3-lookup-pepper-at-least-16-bytes',
  SPOTT_WEB_BFF_KEYS: `${bffKid}:${bffKey}`,
  SPOTT_WEB_BFF_CURRENT_KID: bffKid,
  REFRESH_TOKEN_DERIVATION_KEYS: `refresh-2026-07:${derivationKey}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-2026-07',
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

interface SeededSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly token: string;
}

interface SeededEmailChallenge {
  readonly challengeId: string;
  readonly deviceId: string;
}

interface RunningAPI {
  readonly process: ChildProcess;
  readonly baseURL: string;
  readonly output: () => string;
}

const seededUserIds: string[] = [];
const seededChallengeIds: string[] = [];

function containsRefreshToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRefreshToken);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    key.toLowerCase() === 'refreshtoken' || containsRefreshToken(child)
  ));
}

async function responseJSON(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  probe.unref();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test API port');
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  return address.port;
}

async function startAPI(mode: WebSessionBFFEnforcement): Promise<RunningAPI> {
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: apiRoot,
    env: { ...process.env, PORT: String(port), WEB_SESSION_BFF_ENFORCEMENT: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Compiled API exited before readiness in ${mode} mode:\n${output}`);
    }
    try {
      const health = await fetch(`${baseURL}/v1/health`);
      if (health.ok) return { process: child, baseURL, output: () => output };
    } catch {
      // The compiled API has not opened its socket yet.
    }
    await delay(100);
  }
  child.kill('SIGKILL');
  throw new Error(`Compiled API did not become ready in ${mode} mode:\n${output}`);
}

async function stopAPI(api: RunningAPI): Promise<void> {
  if (api.process.exitCode !== null) return;
  api.process.kill('SIGTERM');
  await Promise.race([once(api.process, 'exit'), delay(5_000)]);
  if (api.process.exitCode === null) api.process.kill('SIGKILL');
}

describe('real HTTP Web BFF transport boundary', () => {
  let api: RunningAPI;
  let baseURL: string;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseURL, application_name: 'spott-task3-boundary-test' });
    await client.connect();
    await client.query('DELETE FROM identity.web_bff_request_nonces WHERE signing_kid = $1', [bffKid]);

    await execFileAsync('pnpm', ['run', 'build'], {
      cwd: apiRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    api = await startAPI('off');
    baseURL = api.baseURL;
  }, 60_000);

  afterAll(async () => {
    if (api) await stopAPI(api);
    if (client) {
      if (seededUserIds.length > 0) {
        await client.query(
          `UPDATE identity.sessions
           SET current_binding_id = NULL, current_binding_generation = NULL
           WHERE user_id = ANY($1::uuid[])`,
          [seededUserIds],
        );
        await client.query('DELETE FROM sync.idempotency_keys WHERE user_id = ANY($1::uuid[])', [seededUserIds]);
        await client.query('DELETE FROM identity.device_bindings WHERE user_id = ANY($1::uuid[])', [seededUserIds]);
        await client.query('DELETE FROM identity.sessions WHERE user_id = ANY($1::uuid[])', [seededUserIds]);
        await client.query('DELETE FROM identity.devices WHERE user_id = ANY($1::uuid[])', [seededUserIds]);
        await client.query('DELETE FROM identity.auth_identities WHERE user_id = ANY($1::uuid[])', [seededUserIds]);
        await client.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [seededUserIds]);
      }
      if (seededChallengeIds.length > 0) {
        await client.query('DELETE FROM identity.email_challenges WHERE id = ANY($1::uuid[])', [seededChallengeIds]);
      }
      await client.query('DELETE FROM identity.web_bff_request_nonces WHERE signing_kid = $1', [bffKid]);
      await client.end();
    }
  }, 30_000);

  async function seedSession(
    suffix: string,
    transportClass: SessionTransportClass,
    platform: 'ios' | 'web' | 'ops',
  ): Promise<SeededSession> {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const refreshHash = createHmac('sha256', refreshSecretKey).update(secret).digest();

    seededUserIds.push(userId);
    await client.query(
      `INSERT INTO identity.users(id, public_handle)
       VALUES ($1, $2)`,
      [userId, `task3_${randomUUID().replaceAll('-', '').slice(0, 12)}`],
    );
    await client.query(
      `INSERT INTO identity.devices(id, user_id, platform)
       VALUES ($1, $2, $3)`,
      [deviceId, userId, platform],
    );
    await client.query(
      `INSERT INTO identity.sessions(
         id, user_id, device_id, refresh_hash, refresh_family_id,
         expires_at, transport_class
       ) VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '30 days', $6)`,
      [sessionId, userId, deviceId, refreshHash, familyId, transportClass],
    );
    return { userId, deviceId, sessionId, familyId, token: `${sessionId}.${secret}` };
  }

  async function seedEmailChallenge(): Promise<SeededEmailChallenge> {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const challengeId = randomUUID();
    const emailHash = randomBytes(32);
    const codeHash = createHmac('sha256', refreshSecretKey).update('123456').digest();
    seededUserIds.push(userId);
    seededChallengeIds.push(challengeId);
    await client.query(
      `INSERT INTO identity.users(id, public_handle)
       VALUES ($1, $2)`,
      [userId, `task3_${randomUUID().replaceAll('-', '').slice(0, 12)}`],
    );
    await client.query(
      `INSERT INTO identity.auth_identities(user_id, provider, provider_subject, email_cipher, email_hash)
       VALUES ($1, 'email', $2, $3, $4)`,
      [userId, emailHash.toString('hex'), Buffer.alloc(48, 5), emailHash],
    );
    await client.query(
      `INSERT INTO identity.email_challenges(
         id, email_hash, email_cipher, code_hash, device_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '10 minutes')`,
      [challengeId, emailHash, Buffer.alloc(48, 5), codeHash, deviceId],
    );
    return { challengeId, deviceId };
  }

  async function postRefresh(
    body: string,
    headers: Record<string, string> = {},
    targetBaseURL = baseURL,
  ): Promise<Response> {
    return postJSONWithoutBrowserHeaders(`${targetBaseURL}/v1/auth/refresh`, body, headers);
  }

  async function postEmailVerify(
    targetBaseURL: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return postJSONWithoutBrowserHeaders(`${targetBaseURL}/v1/auth/email/verify`, body, headers);
  }

  async function postJSONWithoutBrowserHeaders(
    targetURL: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const target = new URL(targetURL);
    if (target.protocol !== 'http:') {
      throw new Error(`Test HTTP client only supports loopback http URLs: ${targetURL}`);
    }

    return new Promise<Response>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('error', rejectResponse);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(
              response.rawHeaders[index] ?? '',
              response.rawHeaders[index + 1] ?? '',
            );
          }
          resolveResponse(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage ?? '',
            headers: responseHeaders,
          }));
        });
      });
      request.on('error', rejectResponse);
      request.end(body);
    });
  }

  it('sends native probes without browser or BFF authority headers', async () => {
    const observed: Array<{ path: string | undefined; headers: IncomingHttpHeaders }> = [];
    const probe = createHTTPServer((request, response) => {
      observed.push({ path: request.url, headers: request.headers });
      request.resume();
      request.on('end', () => {
        response.statusCode = 201;
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      });
    });
    probe.unref();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not allocate the native HTTP header probe');
    }
    const probeBaseURL = `http://127.0.0.1:${address.port}`;

    try {
      await expect(postRefresh('{}', {}, probeBaseURL)).resolves.toMatchObject({ status: 201 });
      await expect(postEmailVerify(probeBaseURL, '{}')).resolves.toMatchObject({ status: 201 });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        probe.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    }

    expect(observed.map(({ path }) => path)).toEqual([
      '/v1/auth/refresh',
      '/v1/auth/email/verify',
    ]);
    for (const { headers } of observed) {
      expect(headers['content-type']).toBe('application/json');
      expect(headers['content-length']).toBe('2');
      expect(Object.keys(headers).filter((name) => (
        name === 'origin'
        || name.startsWith('sec-fetch-')
        || name.startsWith('x-spott-bff-')
      ))).toEqual([]);
    }
  });

  function signedHeaders(path: string, body: string): Record<string, string> {
    const timestamp = Date.now();
    const nonce = `nonce-${randomUUID().replaceAll('-', '')}`;
    const keyring = parseVersionedKeyring(`${bffKid}:${bffKey}`, bffKid);
    return {
      'x-spott-bff-version': 'v1',
      'x-spott-bff-kid': bffKid,
      'x-spott-bff-timestamp': String(timestamp),
      'x-spott-bff-nonce': nonce,
      'x-spott-bff-signature': signBFFAuthority({
        keyring,
        version: 'v1',
        kid: bffKid,
        method: 'POST',
        path,
        timestamp,
        nonce,
        bodyHash: createHash('sha256').update(body).digest('hex'),
      }),
    };
  }

  async function upgradeWebSessionBinding(
    seeded: SeededSession,
    targetBaseURL = baseURL,
    requestHeaders: Record<string, string> = {},
  ) {
    const path = '/v1/auth/device-binding/upgrade';
    const bindingId = randomUUID();
    const proof = randomBytes(32).toString('base64url');
    const body = JSON.stringify({
      refreshToken: seeded.token,
      deviceId: seeded.deviceId,
      attemptId: randomUUID(),
      newBinding: {
        bindingId,
        generation: 0,
        proof,
        proofClass: 'persistent',
      },
    });
    const response = await postJSONWithoutBrowserHeaders(`${targetBaseURL}${path}`, body, {
      ...requestHeaders,
      ...signedHeaders(path, body),
    });
    expect(response.status).toBe(200);
    return {
      deviceBindingProof: { bindingId, generation: 0, proof, proofClass: 'persistent' as const },
      refreshEnvelopeClaims: {
        sessionId: seeded.sessionId,
        familyId: seeded.familyId,
        generation: 0,
        transportClass: 'web_bff' as const,
        persistentBindingId: bindingId,
        persistentBindingGeneration: 0,
      },
    };
  }

  async function sessionTransport(response: Response): Promise<SessionTransportClass | undefined> {
    const json = await responseJSON(response) as { sessionId?: string };
    if (!json.sessionId) return undefined;
    const result = await client.query<{ transport_class: SessionTransportClass }>(
      'SELECT transport_class FROM identity.sessions WHERE id = $1',
      [json.sessionId],
    );
    return result.rows[0]?.transport_class;
  }

  async function expectRejectedWithoutRefresh(response: Response): Promise<unknown> {
    expect([401, 403]).toContain(response.status);
    const json = await responseJSON(response);
    expect(containsRefreshToken(json)).toBe(false);
    return json;
  }

  async function expectSessionUnchanged(seeded: SeededSession): Promise<void> {
    const state = await client.query<{ revoked_at: Date | null; reuse_detected_at: Date | null }>(
      'SELECT revoked_at, reuse_detected_at FROM identity.sessions WHERE id = $1',
      [seeded.sessionId],
    );
    expect(state.rows).toEqual([{ revoked_at: null, reuse_detected_at: null }]);
    const count = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM identity.sessions WHERE user_id = $1',
      [seeded.userId],
    );
    expect(count.rows[0]?.count).toBe('1');
  }

  it('rejects a headerless genuine web_bff credential before the controller can rotate it', async () => {
    const seeded = await seedSession('headerless', 'web_bff', 'web');
    const response = await postRefresh(JSON.stringify({
      refreshToken: seeded.token,
      deviceId: seeded.deviceId,
    }));

    await expectRejectedWithoutRefresh(response);
    const state = await client.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM identity.sessions WHERE id = $1',
      [seeded.sessionId],
    );
    expect(state.rows[0]?.revoked_at).toBeNull();
  });

  it('does not trust a forged native caller platform or body-supplied authority metadata', async () => {
    const seeded = await seedSession('forged_native', 'web_bff', 'web');
    const response = await postRefresh(JSON.stringify({
      refreshToken: seeded.token,
      deviceId: seeded.deviceId,
      platform: 'ios',
      verifiedBFFAuthority: {
        version: 'v1',
        kid: bffKid,
        timestamp: Date.now(),
        nonceHash: Buffer.alloc(32).toString('base64url'),
      },
    }));

    await expectRejectedWithoutRefresh(response);
  });

  it('does not route a valid stored Ops credential through consumer refresh', async () => {
    const seeded = await seedSession('ops_consumer', 'ops', 'ops');
    const response = await postRefresh(JSON.stringify({
      refreshToken: seeded.token,
      deviceId: seeded.deviceId,
      platform: 'ios',
    }));

    await expectRejectedWithoutRefresh(response);
    const state = await client.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM identity.sessions WHERE id = $1',
      [seeded.sessionId],
    );
    expect(state.rows[0]?.revoked_at).toBeNull();
  });

  it.each([
    ['native', 'ios'],
    ['legacy_unclassified', 'web'],
  ] as const)(
    'preserves unsigned first-use compatibility and successor class for %s',
    async (transportClass, platform) => {
      const seeded = await seedSession(`compatible_${transportClass}`, transportClass, platform);
      const response = await postRefresh(JSON.stringify({
        refreshToken: seeded.token,
        deviceId: seeded.deviceId,
      }));

      expect(response.status).toBe(201);
      const json = await responseJSON(response) as { sessionId?: string; refreshToken?: string };
      expect(json.refreshToken).toBeTypeOf('string');
      const successor = await client.query<{ transport_class: SessionTransportClass; platform: string }>(
        `SELECT session.transport_class, device.platform
         FROM identity.sessions AS session
         JOIN identity.devices AS device ON device.id = session.device_id
         WHERE session.id = $1`,
        [json.sessionId],
      );
      expect(successor.rows).toEqual([{ transport_class: transportClass, platform }]);
    },
  );

  it('keeps Ops first-use refresh on the Ops Cookie route and inherits ops', async () => {
    const seeded = await seedSession('ops_route', 'ops', 'ops');
    const response = await fetch(`${baseURL}/v1/ops/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: `__Host-spott_ops_refresh=${encodeURIComponent(seeded.token)}`,
        origin: 'http://localhost:3001',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    });

    expect(response.status).toBe(200);
    const json = await responseJSON(response) as { sessionId?: string };
    expect(containsRefreshToken(json)).toBe(false);
    const successor = await client.query<{ transport_class: SessionTransportClass }>(
      'SELECT transport_class FROM identity.sessions WHERE id = $1',
      [json.sessionId],
    );
    expect(successor.rows).toEqual([{ transport_class: 'ops' }]);
  });

  it('rejects oversized refresh material before it can query or revoke the referenced session', async () => {
    const seeded = await seedSession('oversized', 'native', 'ios');
    const response = await postRefresh(JSON.stringify({
      refreshToken: `${seeded.sessionId}.${'a'.repeat(1_024)}`,
      deviceId: seeded.deviceId,
    }));

    const json = await expectRejectedWithoutRefresh(response);
    expect(json).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
    const state = await client.query<{ revoked_at: Date | null; reuse_detected_at: Date | null }>(
      'SELECT revoked_at, reuse_detected_at FROM identity.sessions WHERE id = $1',
      [seeded.sessionId],
    );
    expect(state.rows).toEqual([{ revoked_at: null, reuse_detected_at: null }]);
  });

  it('accepts a valid one-time BFF authority and explicitly inherits web_bff on its successor', async () => {
    const seeded = await seedSession('signed', 'web_bff', 'web');
    const binding = await upgradeWebSessionBinding(seeded);
    const attemptId = randomUUID();
    const body = JSON.stringify({
      refreshToken: seeded.token,
      deviceId: seeded.deviceId,
      ...binding,
    });
    const timestamp = Date.now();
    const nonce = `nonce-${randomUUID().replaceAll('-', '')}`;
    const keyring = parseVersionedKeyring(`${bffKid}:${bffKey}`, bffKid);
    const signature = signBFFAuthority({
      keyring,
      version: 'v1',
      kid: bffKid,
      method: 'POST',
      path: '/v1/auth/refresh',
      timestamp,
      nonce,
      bodyHash: createHash('sha256').update(body).digest('hex'),
    });
    const headers = {
      'x-spott-bff-version': 'v1',
      'x-spott-bff-kid': bffKid,
      'x-spott-bff-timestamp': String(timestamp),
      'x-spott-bff-nonce': nonce,
      'x-spott-bff-signature': signature,
      'idempotency-key': attemptId,
    };

    const response = await postRefresh(body, headers);
    expect(response.status).toBe(201);
    const json = await responseJSON(response) as { sessionId?: string; refreshToken?: string };
    expect(json.refreshToken).toBeTypeOf('string');
    expect(json.sessionId).toBeTypeOf('string');

    const successor = await client.query<{ transport_class: SessionTransportClass }>(
      'SELECT transport_class FROM identity.sessions WHERE id = $1',
      [json.sessionId],
    );
    expect(successor.rows).toEqual([{ transport_class: 'web_bff' }]);

    const replay = await postRefresh(body, headers);
    const replayJSON = await expectRejectedWithoutRefresh(replay);
    expect(replayJSON).toMatchObject({ error: { code: 'WEB_BFF_AUTHORITY_INVALID' } });
    const nonceRows = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM identity.web_bff_request_nonces WHERE signing_kid = $1',
      [bffKid],
    );
    expect(nonceRows.rows[0]?.count).toBe('2');
  });

  it('hard-requires one-time BFF authority before the first persistent binding mutation', async () => {
    const seeded = await seedSession('binding_upgrade', 'web_bff', 'web');
    const path = '/v1/auth/device-binding/upgrade';
    const proof = randomBytes(32).toString('base64url');
    const body = JSON.stringify({
      refreshToken: seeded.token,
      deviceId: seeded.deviceId,
      attemptId: randomUUID(),
      newBinding: {
        bindingId: randomUUID(),
        generation: 0,
        proof,
        proofClass: 'persistent',
      },
    });

    const unsigned = await postJSONWithoutBrowserHeaders(`${baseURL}${path}`, body, {
      origin: 'https://spott.jp',
      'sec-fetch-site': 'same-origin',
    });
    const unsignedJSON = await expectRejectedWithoutRefresh(unsigned);
    expect(unsignedJSON).toMatchObject({ error: { code: 'WEB_BFF_AUTHORITY_REQUIRED' } });
    const before = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM identity.device_bindings WHERE session_id = $1',
      [seeded.sessionId],
    );
    expect(before.rows).toEqual([{ count: '0' }]);

    const signed = await postJSONWithoutBrowserHeaders(`${baseURL}${path}`, body, {
      origin: 'https://spott.jp',
      'sec-fetch-site': 'same-origin',
      ...signedHeaders(path, body),
    });
    expect(signed.status).toBe(200);
    const material = await responseJSON(signed);
    expect(material).toMatchObject({
      sessionId: seeded.sessionId,
      transportClass: 'web_bff',
      bindingGeneration: 0,
    });
    expect(containsRefreshToken(material)).toBe(false);
    expect(JSON.stringify(material)).not.toContain(proof);
    const after = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM identity.device_bindings WHERE session_id = $1',
      [seeded.sessionId],
    );
    expect(after.rows).toEqual([{ count: '1' }]);
  });

  it.each(['off', 'observe', 'enforce'] as const)(
    'enforces stored native, web_bff, and ops request channels over real HTTP in %s mode',
    async (mode) => {
      const modeAPI = mode === 'off' ? api : await startAPI(mode);
      const browserHeaders = {
        origin: 'https://spott.jp',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      };
      try {
        const nativeHeaderless = await seedSession(`matrix_native_headerless_${mode}`, 'native', 'ios');
        const nativeHeaderlessBody = JSON.stringify({
          refreshToken: nativeHeaderless.token,
          deviceId: nativeHeaderless.deviceId,
        });
        const nativeHeaderlessResponse = await postRefresh(
          nativeHeaderlessBody,
          {},
          modeAPI.baseURL,
        );
        expect(nativeHeaderlessResponse.status).toBe(201);
        await expect(sessionTransport(nativeHeaderlessResponse)).resolves.toBe('native');

        const nativeBrowser = await seedSession(`matrix_native_browser_${mode}`, 'native', 'ios');
        const nativeBrowserBody = JSON.stringify({
          refreshToken: nativeBrowser.token,
          deviceId: nativeBrowser.deviceId,
        });
        await expectRejectedWithoutRefresh(await postRefresh(
          nativeBrowserBody,
          browserHeaders,
          modeAPI.baseURL,
        ));
        await expectSessionUnchanged(nativeBrowser);

        const nativeSigned = await seedSession(`matrix_native_signed_${mode}`, 'native', 'ios');
        const nativeSignedBody = JSON.stringify({
          refreshToken: nativeSigned.token,
          deviceId: nativeSigned.deviceId,
        });
        await expectRejectedWithoutRefresh(await postRefresh(
          nativeSignedBody,
          { ...browserHeaders, ...signedHeaders('/v1/auth/refresh', nativeSignedBody) },
          modeAPI.baseURL,
        ));
        await expectSessionUnchanged(nativeSigned);

        const nativePartial = await seedSession(`matrix_native_partial_${mode}`, 'native', 'ios');
        const nativePartialBody = JSON.stringify({
          refreshToken: nativePartial.token,
          deviceId: nativePartial.deviceId,
        });
        await expectRejectedWithoutRefresh(await postRefresh(
          nativePartialBody,
          { ...browserHeaders, 'x-spott-bff-version': 'v1' },
          modeAPI.baseURL,
        ));
        await expectSessionUnchanged(nativePartial);

        const nativeForged = await seedSession(`matrix_native_forged_${mode}`, 'native', 'ios');
        const nativeForgedBody = JSON.stringify({
          refreshToken: nativeForged.token,
          deviceId: nativeForged.deviceId,
        });
        const forgedHeaders = signedHeaders('/v1/auth/refresh', nativeForgedBody);
        forgedHeaders['x-spott-bff-signature'] = `A${forgedHeaders['x-spott-bff-signature']?.slice(1)}`;
        await expectRejectedWithoutRefresh(await postRefresh(
          nativeForgedBody,
          { ...browserHeaders, ...forgedHeaders },
          modeAPI.baseURL,
        ));
        await expectSessionUnchanged(nativeForged);

        const webUnsigned = await seedSession(`matrix_web_unsigned_${mode}`, 'web_bff', 'web');
        const webUnsignedBody = JSON.stringify({
          refreshToken: webUnsigned.token,
          deviceId: webUnsigned.deviceId,
        });
        await expectRejectedWithoutRefresh(await postRefresh(
          webUnsignedBody,
          browserHeaders,
          modeAPI.baseURL,
        ));
        await expectSessionUnchanged(webUnsigned);

        const webSigned = await seedSession(`matrix_web_signed_${mode}`, 'web_bff', 'web');
        const webBinding = await upgradeWebSessionBinding(
          webSigned,
          modeAPI.baseURL,
          browserHeaders,
        );
        const webSignedBody = JSON.stringify({
          refreshToken: webSigned.token,
          deviceId: webSigned.deviceId,
          ...webBinding,
        });
        const webSignedResponse = await postRefresh(
          webSignedBody,
          {
            ...browserHeaders,
            ...signedHeaders('/v1/auth/refresh', webSignedBody),
            'idempotency-key': randomUUID(),
          },
          modeAPI.baseURL,
        );
        expect(webSignedResponse.status).toBe(201);
        await expect(sessionTransport(webSignedResponse)).resolves.toBe('web_bff');

        const opsConsumer = await seedSession(`matrix_ops_consumer_${mode}`, 'ops', 'ops');
        const opsConsumerBody = JSON.stringify({
          refreshToken: opsConsumer.token,
          deviceId: opsConsumer.deviceId,
        });
        await expectRejectedWithoutRefresh(await postRefresh(
          opsConsumerBody,
          browserHeaders,
          modeAPI.baseURL,
        ));
        await expectSessionUnchanged(opsConsumer);

        const opsRoute = await seedSession(`matrix_ops_route_${mode}`, 'ops', 'ops');
        const opsResponse = await fetch(`${modeAPI.baseURL}/v1/ops/auth/refresh`, {
          method: 'POST',
          headers: {
            cookie: `__Host-spott_ops_refresh=${encodeURIComponent(opsRoute.token)}`,
            origin: 'http://localhost:3001',
            'sec-fetch-site': 'same-site',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
          },
        });
        expect(opsResponse.status).toBe(200);
        expect(containsRefreshToken(await responseJSON(opsResponse))).toBe(false);
      } finally {
        if (modeAPI !== api) await stopAPI(modeAPI);
      }
    },
    45_000,
  );

  it.each(['off', 'observe', 'enforce'] as const)(
    'applies new-session BFF authority at the real HTTP boundary in %s mode',
    async (mode) => {
      const modeAPI = mode === 'off' ? api : await startAPI(mode);
      const browserHeaders = {
        origin: 'https://spott.jp',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      };
      try {
        const unsigned = await seedEmailChallenge();
        const unsignedBody = JSON.stringify({
          ...unsigned,
          code: '123456',
          platform: 'ios',
          issuedSessionTransportClass: 'native',
          verifiedBFFAuthority: { version: 'v1', kid: bffKid },
        });
        const unsignedResponse = await postEmailVerify(modeAPI.baseURL, unsignedBody, browserHeaders);
        if (mode === 'enforce') {
          await expectRejectedWithoutRefresh(unsignedResponse);
          const rows = await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM identity.sessions WHERE device_id = $1',
            [unsigned.deviceId],
          );
          expect(rows.rows[0]?.count).toBe('0');
        } else {
          expect(unsignedResponse.status).toBe(201);
          await expect(sessionTransport(unsignedResponse)).resolves.toBe('legacy_unclassified');
        }

        const partial = await seedEmailChallenge();
        const partialBody = JSON.stringify({ ...partial, code: '123456', platform: 'ios' });
        const partialResponse = await postEmailVerify(modeAPI.baseURL, partialBody, {
          ...browserHeaders,
          'x-spott-bff-version': 'v1',
        });
        const partialJSON = await expectRejectedWithoutRefresh(partialResponse);
        expect(partialJSON).toMatchObject({ error: { code: 'WEB_BFF_AUTHORITY_INVALID' } });

        const signed = await seedEmailChallenge();
        const signedBody = JSON.stringify({ ...signed, code: '123456', platform: 'ios' });
        const signedResponse = await postEmailVerify(modeAPI.baseURL, signedBody, {
          ...browserHeaders,
          ...signedHeaders('/v1/auth/email/verify', signedBody),
        });
        expect(signedResponse.status).toBe(201);
        await expect(sessionTransport(signedResponse)).resolves.toBe('web_bff');

        const native = await seedEmailChallenge();
        const nativeBody = JSON.stringify({ ...native, code: '123456' });
        const nativeResponse = await postEmailVerify(modeAPI.baseURL, nativeBody);
        expect(nativeResponse.status).toBe(201);
        await expect(sessionTransport(nativeResponse)).resolves.toBe('native');
      } finally {
        if (modeAPI !== api) await stopAPI(modeAPI);
      }
    },
    30_000,
  );
});
