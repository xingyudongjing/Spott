import { expect, test } from 'vitest';

import { GET } from '../app/api/session/bootstrap/route';

test('GET /api/session/bootstrap exposes only the credentialless bootstrap handler', async () => {
  const response = await GET(new Request('https://spott.example/api/session/bootstrap'));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ state: 'anonymous' });
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('set-cookie')).toBeNull();
});
