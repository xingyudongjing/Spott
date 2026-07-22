import { expect, test } from 'vitest';

import {
  dynamic as currentDynamic,
  POST as logout,
  revalidate as currentRevalidate,
} from '../app/api/session/logout/route';
import {
  dynamic as allDynamic,
  POST as logoutAll,
  revalidate as allRevalidate,
} from '../app/api/session/logout-all/route';

test('logout routes expose dynamic fail-closed terminal handlers', async () => {
  expect(currentDynamic).toBe('force-dynamic');
  expect(allDynamic).toBe('force-dynamic');
  expect(currentRevalidate).toBe(0);
  expect(allRevalidate).toBe(0);

  for (const route of [logout, logoutAll]) {
    const response = await route(new Request('https://spott.example/api/session/logout', {
      method: 'POST',
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_LOGOUT_UNAVAILABLE', retryable: true },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  }
});
