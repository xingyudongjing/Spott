export type { components, operations, paths } from './schema.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

export interface TokenStore {
  get(): Promise<SessionTokens | null>;
  set(tokens: SessionTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface ClientOptions {
  baseURL: string;
  tokenStore?: TokenStore;
  fetch?: typeof globalThis.fetch;
  onTrace?: (trace: { requestId: string; method: string; path: string; durationMs: number; status: number }) => void;
}

export interface RequestOptions<TBody = unknown> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: TBody;
  headers?: HeadersInit;
  authenticated?: boolean;
  idempotencyKey?: string;
  ifMatch?: number;
  signal?: AbortSignal;
  retry?: boolean;
}

export interface ProblemDetails {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
    fieldErrors?: Array<{ field: string; message: string }>;
    actions?: Array<{ type: string; label: string }>;
    meta?: Record<string, unknown>;
  };
}

export class SpottAPIError extends Error {
  constructor(readonly status: number, readonly problem: ProblemDetails) {
    super(problem.error.message);
    this.name = 'SpottAPIError';
  }

  get code(): string { return this.problem.error.code; }
  get retryable(): boolean { return this.problem.error.retryable ?? this.status >= 500; }
}

export class SpottClient {
  private readonly fetcher: typeof globalThis.fetch;
  private refreshPromise: Promise<SessionTokens> | null = null;

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<TResponse, TBody = unknown>(path: string, options: RequestOptions<TBody> = {}): Promise<TResponse> {
    const method = options.method ?? 'GET';
    const authenticated = options.authenticated ?? true;
    const tokens = authenticated ? await this.options.tokenStore?.get() : null;
    const requestId = globalThis.crypto.randomUUID();
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    headers.set('x-request-id', requestId);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (tokens) {
      headers.set('authorization', `Bearer ${tokens.accessToken}`);
      headers.set('x-spott-device-id', tokens.deviceId);
    }
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    if (options.ifMatch !== undefined) headers.set('if-match', `"${options.ifMatch}"`);

    const started = performance.now();
    let response: Response;
    const requestInit: RequestInit = {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    try {
      response = await this.fetchWithRetry(
        this.url(path),
        requestInit,
        options.retry ?? this.isRetrySafe(method, options.idempotencyKey),
      );
      if (response.status === 401 && authenticated && tokens && this.options.tokenStore) {
        const refreshed = await this.refresh(tokens);
        headers.set('authorization', `Bearer ${refreshed.accessToken}`);
        response = await this.fetcher(this.url(path), requestInit);
      }
    } finally {
      // Trace emission happens below once the HTTP status is known.
    }
    this.options.onTrace?.({ requestId, method, path, durationMs: performance.now() - started, status: response.status });
    if (!response.ok) throw new SpottAPIError(response.status, await this.problem(response, requestId));
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as TResponse;
    return response.json() as Promise<TResponse>;
  }

  private async refresh(current: SessionTokens): Promise<SessionTokens> {
    this.refreshPromise ??= (async () => {
      const response = await this.fetcher(this.url('/auth/refresh'), {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken, deviceId: current.deviceId }),
      });
      if (!response.ok) {
        await this.options.tokenStore!.clear();
        throw new SpottAPIError(response.status, await this.problem(response, 'refresh'));
      }
      const session = await response.json() as { accessToken: string; refreshToken: string };
      const updated = { accessToken: session.accessToken, refreshToken: session.refreshToken, deviceId: current.deviceId };
      await this.options.tokenStore!.set(updated);
      return updated;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async fetchWithRetry(url: string, init: RequestInit, enabled: boolean): Promise<Response> {
    const attempts = enabled ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetcher(url, init);
        if (attempt + 1 === attempts || ![429, 502, 503, 504].includes(response.status)) return response;
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : this.backoff(attempt), init.signal);
      } catch (error) {
        lastError = error;
        if (attempt + 1 === attempts || init.signal?.aborted) throw error;
        await this.delay(this.backoff(attempt), init.signal);
      }
    }
    throw lastError;
  }

  private async problem(response: Response, requestId: string): Promise<ProblemDetails> {
    try { return await response.json() as ProblemDetails; }
    catch { return { error: { code: `HTTP_${response.status}`, message: '请求暂时无法完成。', requestId, retryable: response.status >= 500 } }; }
  }

  private url(path: string): string { return `${this.options.baseURL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`; }
  private isRetrySafe(method: string, key?: string): boolean { return ['GET', 'PUT', 'DELETE'].includes(method) || Boolean(key); }
  private backoff(attempt: number): number { return Math.min(5_000, 250 * 2 ** attempt) * (0.75 + Math.random() * 0.5); }
  private delay(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  }
}
