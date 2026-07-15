import type { DomainErrorShape } from './types.js';

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors: DomainErrorShape['fieldErrors'];
  readonly actions: DomainErrorShape['actions'];
  readonly meta: DomainErrorShape['meta'];

  constructor(
    code: string,
    message: string,
    status = 422,
    options: Partial<Omit<DomainErrorShape, 'code' | 'message'>> = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors ?? [];
    this.actions = options.actions ?? [];
    this.meta = options.meta ?? {};
  }

  toJSON(): DomainErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      fieldErrors: this.fieldErrors,
      actions: this.actions,
      meta: this.meta,
    };
  }
}
