import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { configuration } from '../config.js';
import { IS_PUBLIC_KEY, type AuthenticatedUser, type SpottRequest } from './request-context.js';

interface AccessClaims {
  sub: string;
  sid: string;
  phoneVerified?: boolean;
  restrictions?: string[];
  roles?: string[];
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<SpottRequest>();
    const cookieToken = this.cookie(request.headers.cookie, '__Host-spott_ops');
    const authorization = request.headers.authorization ?? (cookieToken ? `Bearer ${cookieToken}` : undefined);
    if (!authorization) {
      const demoUser = request.headers['x-spott-user-id'];
      if (configuration().NODE_ENV !== 'production' && typeof demoUser === 'string') {
        request.user = {
          id: demoUser,
          sessionId: 'development-session',
          phoneVerified: request.headers['x-spott-phone-verified'] !== 'false',
          restrictions: [],
          roles: request.headers['x-spott-role'] === 'operator' ? ['operator'] : ['verified'],
        };
        return true;
      }
      if (isPublic) return true;
      throw new UnauthorizedException('AUTH_REQUIRED');
    }

    if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const config = configuration();
      const allowedOrigins = new Set([
        ...config.OPS_ORIGIN,
        ...(config.NODE_ENV === 'development'
          ? ['http://localhost:3001', 'http://127.0.0.1:3001']
          : []),
      ]);
      if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
        throw new ForbiddenException('OPS_CSRF_ORIGIN_INVALID');
      }
    }

    const [scheme, token] = authorization.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('AUTH_REQUIRED');
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET),
        { algorithms: ['HS256'], issuer: 'spott-api', audience: 'spott-clients' },
      );
      const claims = verified.payload as unknown as AccessClaims;
      const user: AuthenticatedUser = {
        id: claims.sub,
        sessionId: claims.sid,
        phoneVerified: claims.phoneVerified ?? false,
        restrictions: claims.restrictions ?? [],
        roles: claims.roles ?? ['user'],
      };
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('TOKEN_EXPIRED');
    }
  }

  private cookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    const entry = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    if (!entry) return undefined;
    try {
      return decodeURIComponent(entry.slice(name.length + 1));
    } catch {
      throw new UnauthorizedException('TOKEN_INVALID');
    }
  }
}
