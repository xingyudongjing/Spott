import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SpottAPIError, SpottClient, type TokenStore } from '../src/index.js';

describe('SpottClient', () => {
  it('adds trace and idempotency headers', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-request-id')).toBeTruthy();
      expect(headers.get('idempotency-key')).toBe('6c34c76f-1d6e-4db7-8950-61371528b745');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new SpottClient({
      baseURL: 'https://api.spott.test/v1',
      fetch: fetcher as typeof fetch,
    });
    await expect(
      client.request('/events', {
        method: 'POST',
        authenticated: false,
        body: {},
        idempotencyKey: '6c34c76f-1d6e-4db7-8950-61371528b745',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('uses a single refresh flight after a 401', async () => {
    let access = 'old';
    const store: TokenStore = {
      get: async () => ({ accessToken: access, refreshToken: 'refresh', deviceId: 'device' }),
      set: async (tokens) => {
        access = tokens.accessToken;
      },
      clear: async () => undefined,
    };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/auth/refresh'))
        return new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'next' }), {
          status: 200,
        });
      if (access === 'old')
        return new Response(
          JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }),
          { status: 401 },
        );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new SpottClient({
      baseURL: 'https://api.spott.test/v1',
      fetch: fetcher as typeof fetch,
      tokenStore: store,
    });
    await expect(client.request('/wallet')).resolves.toEqual({ ok: true });
  });

  it('maps problem details to a stable error', async () => {
    const client = new SpottClient({
      baseURL: 'https://api.spott.test',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 'CAPACITY_FULL', message: '已满' } }), {
          status: 409,
        })) as typeof fetch,
    });
    await expect(
      client.request('/register', { authenticated: false, retry: false }),
    ).rejects.toMatchObject<Partial<SpottAPIError>>({ status: 409, code: 'CAPACITY_FULL' });
  });
});

describe('OpenAPI feedback contract', () => {
  it('matches the runtime structured feedback input and privacy-thresholded summary', async () => {
    const contract = await readFile(
      new URL('../../contracts/openapi.yaml', import.meta.url),
      'utf8',
    );
    const input = contract.slice(
      contract.indexOf('    FeedbackInput:'),
      contract.indexOf('    FeedbackSummary:'),
    );
    const summary = contract.slice(
      contract.indexOf('    FeedbackSummary:'),
      contract.indexOf('    WalletBalance:'),
    );

    expect(input).toContain('required: [attendanceRating, tags]');
    expect(input).toContain('attendanceRating: { type: integer, minimum: 1, maximum: 5 }');
    expect(input).toContain(
      'enum: [friendly, well_organized, clear_information, safe, would_join_again]',
    );
    expect(input).toContain('comment: { type: string, maxLength: 500 }');
    expect(input).toContain(
      'visibility: { type: string, enum: [private, aggregate_only], default: aggregate_only }',
    );
    expect(input).not.toContain('privateSuggestion');

    expect(summary).toContain('required: [sampleSize, minimumSampleSize, published, tags]');
    expect(summary).toContain('sampleSize: { type: integer, minimum: 0 }');
    expect(summary).toContain('minimumSampleSize: { type: integer, minimum: 1 }');
    expect(summary).toContain('rate: { type: number, minimum: 0, maximum: 1 }');
    expect(summary).not.toContain('eligibleCount');
  });

  it('documents the authenticated own-state GET and typed idempotent feedback receipt', async () => {
    const contract = await readFile(
      new URL('../../contracts/openapi.yaml', import.meta.url),
      'utf8',
    );
    const path = contract.slice(
      contract.indexOf('  /registrations/{id}/feedback:'),
      contract.indexOf('  /events/{id}/feedback-summary:'),
    );
    const schemas = contract.slice(
      contract.indexOf('    FeedbackInput:'),
      contract.indexOf('    FeedbackSummary:'),
    );

    expect(path).toContain('operationId: getOwnEventFeedback');
    expect(path).toContain("schema: { $ref: '#/components/schemas/OwnFeedbackState' }");
    expect(path).toContain("$ref: '#/components/parameters/IdempotencyKey'");
    expect(path).toContain("schema: { $ref: '#/components/schemas/FeedbackReceipt' }");
    expect(schemas).toContain('FeedbackSubmissionState:');
    expect(schemas).toContain(
      'enum: [not_submitted, edit_available, edit_limit_reached, window_closed, not_eligible]',
    );
    expect(schemas).toContain('OwnFeedback:');
    expect(schemas).toContain('OwnFeedbackState:');
    expect(schemas).toContain(
      'required: [registrationId, eventId, state, canSubmit, canEdit, windowClosesAt, feedback]',
    );
    expect(schemas).toContain('FeedbackReceipt:');
    expect(schemas).toContain(
      'required: [id, eventId, status, editCount, rewardPoints, createdAt]',
    );
  });

  it('documents the exact safety report receipt returned by the runtime', async () => {
    const contract = await readFile(
      new URL('../../contracts/openapi.yaml', import.meta.url),
      'utf8',
    );
    const path = contract.slice(contract.indexOf('  /reports:'), contract.indexOf('  /appeals:'));
    const receipt = contract.slice(
      contract.indexOf('    ReportReceipt:'),
      contract.indexOf('    ReportInput:'),
    );

    expect(path).toContain("schema: { $ref: '#/components/schemas/ReportReceipt' }");
    expect(receipt).toContain('required: [reference, status, submittedAt]');
    expect(receipt).toContain(
      "reference: { type: string, pattern: '^SPT-[0-9]{4}-[A-F0-9]{12}$' }",
    );
    expect(receipt).toContain('status: { type: string, enum: [open] }');
    expect(receipt).toContain('submittedAt: { type: string, format: date-time }');
  });
});

describe('generated cross-surface contract', () => {
  it('generates the stable refresh and read-only bootstrap session contract', async () => {
    const schema = await readFile(new URL('../src/schema.d.ts', import.meta.url), 'utf8');

    expect(schema).toContain('"/auth/refresh"');
    expect(schema).toContain('"/auth/bootstrap"');
    expect(schema).toContain('refreshToken: string;');
    expect(schema).toContain('deviceId: components["schemas"]["UUID"]');
    expect(schema).toContain(
      'deviceBindingProof?: components["schemas"]["PersistentDeviceBindingProof"]',
    );
    expect(schema).toContain('proofClass: "persistent";');
    expect(schema).toContain('refreshGeneration: number;');
  });

  it('generates typed own-feedback GET and idempotent POST operations', async () => {
    const schema = await readFile(new URL('../src/schema.d.ts', import.meta.url), 'utf8');

    const submitFeedback = schema.slice(
      schema.indexOf('    submitEventFeedback:'),
      schema.indexOf('    getEventFeedbackSummary:'),
    );

    expect(schema).toContain('get: operations["getOwnEventFeedback"]');
    expect(schema).toContain('post: operations["submitEventFeedback"]');
    expect(schema).toContain('OwnFeedbackState: {');
    expect(schema).toContain('FeedbackReceipt: {');
    expect(submitFeedback).toContain(
      '"Idempotency-Key": components["parameters"]["IdempotencyKey"]',
    );
  });

  it('generates a narrowed safety report receipt', async () => {
    const schema = await readFile(new URL('../src/schema.d.ts', import.meta.url), 'utf8');
    const createReport = schema.slice(
      schema.indexOf('    createReport:'),
      schema.indexOf('    createAppeal:'),
    );
    const receipt = schema.slice(
      schema.indexOf('        ReportReceipt: {'),
      schema.indexOf('        ReportInput: {'),
    );

    expect(createReport).toContain('"application/json": components["schemas"]["ReportReceipt"]');
    expect(receipt).toContain('reference: string;');
    expect(receipt).toContain('status: "open";');
    expect(receipt).toContain('submittedAt: string;');
  });

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
