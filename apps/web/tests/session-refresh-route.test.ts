import { expect, test } from 'vitest';

import { dynamic, POST, revalidate } from '../app/api/session/refresh/route';

test('POST /api/session/refresh exposes the dynamic fail-closed refresh handler', async () => {
  expect(dynamic).toBe('force-dynamic');
  expect(revalidate).toBe(0);

  const response = await POST(new Request('https://spott.example/api/session/refresh', {
    method: 'POST',
    headers: { cookie: '__Host-spott_refresh=partial' },
  }));

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: { code: 'SESSION_REFRESH_UNAVAILABLE', retryable: true },
  });
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
});
