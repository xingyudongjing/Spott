import { Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIExceptionFilter } from './http-exception.filter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('APIExceptionFilter', () => {
  it('preserves Fastify rate-limit status without exposing its internal error message', () => {
    const status = vi.fn();
    const type = vi.fn();
    const send = vi.fn();
    const reply = { status, type, send };
    status.mockReturnValue(reply);
    type.mockReturnValue(reply);
    const request = {
      method: 'GET',
      requestId: 'req_rate_limit',
      url: '/v1/discovery/events',
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const exception = Object.assign(new Error('Rate limit exceeded, retry in 14 seconds'), {
      statusCode: 429,
    });

    new APIExceptionFilter().catch(exception, host);

    expect(status).toHaveBeenCalledWith(429);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(send).toHaveBeenCalledWith({
      error: {
        actions: [],
        code: 'RATE_LIMITED',
        fieldErrors: [],
        message: '请求过于频繁，请稍后重试。',
        meta: {},
        requestId: 'req_rate_limit',
        retryable: true,
      },
    });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('never writes unknown exception messages or stacks to application logs', () => {
    const status = vi.fn();
    const type = vi.fn();
    const send = vi.fn();
    const reply = { status, type, send };
    status.mockReturnValue(reply);
    type.mockReturnValue(reply);
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          requestId: 'req_secret_redaction',
          url: '/v1/auth/refresh',
        }),
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const secret = 'SUPER_SECRET_INPUT_SHOULD_NOT_LOG';

    new APIExceptionFilter().catch(new Error(secret), host);

    expect(status).toHaveBeenCalledWith(500);
    const serializedLogArguments = JSON.stringify(loggerError.mock.calls);
    expect(serializedLogArguments).not.toContain(secret);
    expect(loggerError).toHaveBeenCalledWith(
      'POST /v1/auth/refresh failed (req_secret_redaction; exception=Error)',
    );
    expect(send).toHaveBeenCalledWith({
      error: {
        actions: [],
        code: 'INTERNAL_ERROR',
        fieldErrors: [],
        message: '服务暂时不可用，请稍后重试。',
        meta: {},
        requestId: 'req_secret_redaction',
        retryable: true,
      },
    });
  });
});
