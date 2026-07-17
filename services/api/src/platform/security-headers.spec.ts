import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerSecurityHeaders } from './security-headers.js';

type Environment = 'development' | 'test' | 'production';

/**
 * Exercises the real registration path with the real production options, so
 * these assertions describe the headers a client actually receives.
 */
async function headersFor(NODE_ENV: Environment) {
  const app = Fastify();
  await registerSecurityHeaders(app, { NODE_ENV });
  app.get('/v1/health', async () => ({ status: 'ok' }));
  const response = await app.inject({ method: 'GET', url: '/v1/health' });
  await app.close();
  return { status: response.statusCode, headers: response.headers };
}

describe('API security headers', () => {
  it('serves a Content-Security-Policy on API responses', async () => {
    const { status, headers } = await headersFor('production');
    expect(status).toBe(200);
    const csp = headers['content-security-policy'];
    expect(csp, 'expected a Content-Security-Policy response header').toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('never relaxes the policy with unsafe-inline or unsafe-eval', async () => {
    const { headers } = await headersFor('production');
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(headers['content-security-policy']).not.toContain('unsafe-eval');
  });

  it('keeps the JSON API free of any script or frame surface', async () => {
    const { headers } = await headersFor('production');
    const csp = String(headers['content-security-policy']);
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('sets nosniff, referrer policy and permissions policy', async () => {
    const { headers } = await headersFor('production');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy'], 'expected a Permissions-Policy header').toBeTruthy();
  });

  it('advertises HSTS in production but not in development', async () => {
    const production = await headersFor('production');
    expect(production.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(production.headers['strict-transport-security']).toContain('includeSubDomains');

    const development = await headersFor('development');
    expect(development.headers['strict-transport-security']).toBeUndefined();
  });
});
