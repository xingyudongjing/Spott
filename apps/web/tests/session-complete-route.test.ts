import { afterEach, expect, test, vi } from 'vitest';

import { POST } from '../app/api/session/complete/route';

const key = Buffer.alloc(32, 0x31).toString('base64url');

afterEach(() => {
  vi.unstubAllEnvs();
});

test('POST /api/session/complete exposes the fail-closed atomic completion handler', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SPOTT_WEB_BFF_KEYS', `bff-current:${key}`);
  vi.stubEnv('SPOTT_WEB_BFF_CURRENT_KID', 'bff-current');
  vi.stubEnv('SPOTT_WEB_CANONICAL_ORIGIN', 'https://spott.example');
  vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:4100/v1');
  vi.stubEnv('WEB_SESSION_RECOVERY_SECONDS', '120');

  const response = await POST(new Request('https://spott.example/api/session/complete', {
    method: 'POST',
    headers: {
      cookie: '__Host-spott_refresh=partial',
      'content-type': 'application/json',
      origin: 'https://spott.example',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body: JSON.stringify({
      credential: {
        provider: 'email',
        challengeId: '88888888-8888-4888-8888-888888888888',
        code: '123456',
      },
      deviceId: '44444444-4444-4444-8444-444444444444',
    }),
  }));

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false },
  });
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
});
