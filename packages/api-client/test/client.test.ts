import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SpottAPIError, SpottClient, type TokenStore } from '../src/index.js';

describe('SpottClient', () => {
  it('adds trace and idempotency headers', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-request-id')).toBeTruthy();
      expect(headers.get('idempotency-key')).toBe('6c34c76f-1d6e-4db7-8950-61371528b745');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new SpottClient({ baseURL: 'https://api.spott.test/v1', fetch: fetcher as typeof fetch });
    await expect(client.request('/events', { method: 'POST', authenticated: false, body: {}, idempotencyKey: '6c34c76f-1d6e-4db7-8950-61371528b745' })).resolves.toEqual({ ok: true });
  });

  it('uses a single refresh flight after a 401', async () => {
    let access = 'old';
    const store: TokenStore = {
      get: async () => ({ accessToken: access, refreshToken: 'refresh', deviceId: 'device' }),
      set: async (tokens) => { access = tokens.accessToken; }, clear: async () => undefined,
    };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'next' }), { status: 200 });
      if (access === 'old') return new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }), { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new SpottClient({ baseURL: 'https://api.spott.test/v1', fetch: fetcher as typeof fetch, tokenStore: store });
    await expect(client.request('/wallet')).resolves.toEqual({ ok: true });
  });

  it('maps problem details to a stable error', async () => {
    const client = new SpottClient({ baseURL: 'https://api.spott.test', fetch: (async () => new Response(JSON.stringify({ error: { code: 'CAPACITY_FULL', message: '已满' } }), { status: 409 })) as typeof fetch });
    await expect(client.request('/register', { authenticated: false, retry: false })).rejects.toMatchObject<Partial<SpottAPIError>>({ status: 409, code: 'CAPACITY_FULL' });
  });
});

describe('OpenAPI feedback contract', () => {
  it('matches the runtime structured feedback input and privacy-thresholded summary', async () => {
    const contract = await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8');
    const input = contract.slice(contract.indexOf('    FeedbackInput:'), contract.indexOf('    FeedbackSummary:'));
    const summary = contract.slice(contract.indexOf('    FeedbackSummary:'), contract.indexOf('    WalletBalance:'));

    expect(input).toContain('required: [attendanceRating, tags]');
    expect(input).toContain('attendanceRating: { type: integer, minimum: 1, maximum: 5 }');
    expect(input).toContain('enum: [friendly, well_organized, clear_information, safe, would_join_again]');
    expect(input).toContain('comment: { type: string, maxLength: 500 }');
    expect(input).toContain('visibility: { type: string, enum: [private, aggregate_only], default: aggregate_only }');
    expect(input).not.toContain('privateSuggestion');

    expect(summary).toContain('required: [sampleSize, minimumSampleSize, published, tags]');
    expect(summary).toContain('sampleSize: { type: integer, minimum: 0 }');
    expect(summary).toContain('minimumSampleSize: { type: integer, minimum: 1 }');
    expect(summary).toContain('rate: { type: number, minimum: 0, maximum: 1 }');
    expect(summary).not.toContain('eligibleCount');
  });
});

describe('generated cross-surface contract', () => {
  it('exposes the event poster and governed Ops workflows to typed web and iOS clients', async () => {
    const schema = await readFile(new URL('../src/schema.d.ts', import.meta.url), 'utf8');

    expect(schema).toContain('get: operations["getEventPoster"]');
    expect(schema).toContain('post: operations["verifyOpsEmailChallenge"]');
    expect(schema).toContain('get: operations["getOpsOverview"]');
    expect(schema).toContain('post: operations["createPointAdjustment"]');
    expect(schema).toContain('post: operations["approveOpsExport"]');
    expect(schema).toContain('OpsAnalyticsOverview: {');
  });
});
