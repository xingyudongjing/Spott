import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import type { SpottRequest } from './request-context.js';

@Catch()
export class APIExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(APIExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<SpottRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let status: number = 500;
    let code = 'INTERNAL_ERROR';
    let message = '服务暂时不可用，请稍后重试。';
    let retryable = true;
    let fieldErrors: Array<{ field: string; message: string }> = [];
    let actions: Array<{ type: string; label: string }> = [];
    let meta: Record<string, unknown> = {};

    if (exception instanceof DomainError) {
      status = exception.status;
      ({ code, message, retryable, fieldErrors, actions, meta } = exception.toJSON());
    } else if (exception instanceof ZodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = '请求参数不符合要求。';
      retryable = false;
      fieldErrors = exception.issues.map((issue) => ({
        field: issue.path.join('.') || 'request',
        message: issue.message,
      }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const unauthorizedStatus = 401;
      const serverErrorStatus = 500;
      code = status === unauthorizedStatus ? String(exception.message) : `HTTP_${status}`;
      message = status === unauthorizedStatus ? '请登录后继续。' : exception.message;
      retryable = status >= serverErrorStatus;
    } else if (isFastifyRateLimitError(exception)) {
      status = 429;
      code = 'RATE_LIMITED';
      message = '请求过于频繁，请稍后重试。';
      retryable = true;
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed (${request.requestId}; exception=${safeExceptionKind(exception)})`,
      );
    }

    void reply.status(status).type('application/problem+json').send({
      error: { code, message, requestId: request.requestId, retryable, fieldErrors, actions, meta },
    });
  }
}

function isFastifyRateLimitError(exception: unknown): exception is Error & { statusCode: 429 } {
  return exception instanceof Error
    && 'statusCode' in exception
    && exception.statusCode === 429;
}

function safeExceptionKind(exception: unknown): string {
  if (exception instanceof DomainError) return 'DomainError';
  if (exception instanceof ZodError) return 'ZodError';
  if (exception instanceof HttpException) return 'HttpException';
  if (exception instanceof Error) return 'Error';
  return 'Unknown';
}
