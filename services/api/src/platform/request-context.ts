import { createParamDecorator, SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const IS_PUBLIC_KEY = 'spott:is-public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthenticatedUser {
  id: string;
  sessionId: string;
  phoneVerified: boolean;
  restrictions: string[];
  roles: string[];
}

export interface SpottRequest extends FastifyRequest {
  user?: AuthenticatedUser;
  requestId: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<SpottRequest>();
    if (!request.user) throw new Error('Authentication guard did not attach a user');
    return request.user;
  },
);
