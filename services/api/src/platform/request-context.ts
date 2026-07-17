import { createParamDecorator, SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  SessionRequestChannel,
  SessionTransportClass,
  VerifiedBFFAuthority,
} from './web-bff-authority.js';

export const IS_PUBLIC_KEY = 'spott:is-public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthenticatedUser {
  id: string;
  sessionId: string;
  phoneVerified: boolean;
  restrictions: string[];
  roles: string[];
}

export interface SpottBFFHeaders {
  'x-spott-bff-version'?: string | string[] | undefined;
  'x-spott-bff-kid'?: string | string[] | undefined;
  'x-spott-bff-timestamp'?: string | string[] | undefined;
  'x-spott-bff-nonce'?: string | string[] | undefined;
  'x-spott-bff-signature'?: string | string[] | undefined;
  'x-spott-device-binding'?: string | string[] | undefined;
}

export interface SpottRequest extends FastifyRequest {
  user?: AuthenticatedUser;
  requestId: string;
  rawBody?: Buffer;
  verifiedBFFAuthority?: VerifiedBFFAuthority;
  sessionRequestChannel?: SessionRequestChannel;
  issuedSessionTransportClass?: SessionTransportClass;
  headers: FastifyRequest['headers'] & SpottBFFHeaders;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<SpottRequest>();
    if (!request.user) throw new Error('Authentication guard did not attach a user');
    return request.user;
  },
);
