import fastifyHelmet from '@fastify/helmet';
import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { Configuration } from '../config.js';

/**
 * The API has no HTML surface: no rendered pages, no Swagger UI, no static
 * assets — only JSON. That makes the strictest possible policy the correct one:
 * every fetch directive falls back to `default-src 'none'`, so a reflected or
 * stolen response has no way to load a script, frame, or image, and the origin
 * cannot be framed for clickjacking.
 *
 * Helmet does not emit Permissions-Policy, so `registerSecurityHeaders` adds it.
 */
export const apiPermissionsPolicy =
  'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), usb=(), xr-spatial-tracking=()';

export function securityHeaderOptions(
  config: Pick<Configuration, 'NODE_ENV'>,
): FastifyHelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'script-src': ["'none'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'frame-ancestors': ["'none'"],
        'sandbox': [],
      },
    },
    strictTransportSecurity:
      config.NODE_ENV === 'production'
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  };
}

/**
 * Registers every response security header for the API. Kept as one function so
 * production and the tests exercise an identical configuration.
 */
export async function registerSecurityHeaders(
  app: FastifyInstance,
  config: Pick<Configuration, 'NODE_ENV'>,
): Promise<void> {
  await app.register(fastifyHelmet, securityHeaderOptions(config));
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Permissions-Policy', apiPermissionsPolicy);
    done(null, payload);
  });
}
