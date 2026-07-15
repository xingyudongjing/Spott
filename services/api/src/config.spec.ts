import { describe, expect, it } from 'vitest';
import { corsOrigins } from './config.js';

describe('corsOrigins', () => {
  it('allows the web fallback port in development and removes duplicates', () => {
    expect(corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000', 'http://localhost:3003'],
      OPS_ORIGIN: ['http://localhost:3001'],
    })).toEqual(expect.arrayContaining([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3003',
    ]));
    expect(new Set(corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000'],
      OPS_ORIGIN: ['http://localhost:3000'],
    })).size).toBe(corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000'],
      OPS_ORIGIN: ['http://localhost:3000'],
    }).length);
  });

  it('does not broaden the production allowlist', () => {
    expect(corsOrigins({
      NODE_ENV: 'production',
      WEB_ORIGIN: ['https://spott.jp'],
      OPS_ORIGIN: ['https://ops.spott.jp'],
    })).toEqual(['https://spott.jp', 'https://ops.spott.jp']);
  });
});
