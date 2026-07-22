import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  dynamic as acceptDynamic,
  POST as accept,
  revalidate as acceptRevalidate,
} from '../app/api/session/completion/accept/route';
import {
  dynamic as discardDynamic,
  POST as discard,
  revalidate as discardRevalidate,
} from '../app/api/session/completion/discard/route';

const key = Buffer.alloc(32, 0x31).toString('base64url');

function configureServer(): void {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SPOTT_WEB_BFF_KEYS', `bff-current:${key}`);
  vi.stubEnv('SPOTT_WEB_BFF_CURRENT_KID', 'bff-current');
  vi.stubEnv('SPOTT_WEB_CANONICAL_ORIGIN', 'https://spott.example');
  vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:4100/v1');
  vi.stubEnv('WEB_SESSION_RECOVERY_SECONDS', '120');
}

function malformedRequest(operation: 'accept' | 'discard'): Request {
  return new Request(`https://spott.example/api/session/completion/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://spott.example',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body: JSON.stringify({ completionToken: '' }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('session completion disposition routes', () => {
  test.each([
    ['accept', accept],
    ['discard', discard],
  ] as const)('wires POST /api/session/completion/%s to the fail-closed handler', async (operation, post) => {
    configureServer();

    const response = await post(malformedRequest(operation));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_COMPLETION_DISPOSITION_REQUEST_INVALID', retryable: false },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('forces both mutation routes to stay dynamic and uncached', () => {
    expect({ acceptDynamic, discardDynamic }).toEqual({
      acceptDynamic: 'force-dynamic',
      discardDynamic: 'force-dynamic',
    });
    expect({ acceptRevalidate, discardRevalidate }).toEqual({
      acceptRevalidate: 0,
      discardRevalidate: 0,
    });
  });
});
