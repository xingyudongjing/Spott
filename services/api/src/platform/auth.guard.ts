import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { configuration, devHeaderAuthEnabled } from '../config.js';
import { IS_PUBLIC_KEY, type SpottRequest } from './request-context.js';
import { SessionAuthority } from './session-authority.js';

export const OPS_ROUTE_KEY = 'spott:is-ops-route';
export const OpsRoute = () => SetMetadata(OPS_ROUTE_KEY, true);

interface AccessClaims {
  sub: string;
  sid: string;
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessionAuthority: SessionAuthority,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isOpsRoute = this.reflector.getAllAndOverride<boolean>(OPS_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<SpottRequest>();
    if (isOpsRoute && this.isUnsafeMethod(request.method)) {
      this.assertOpsMutationMetadata(request);
    }

    const cookieToken = isOpsRoute
      ? this.cookie(request.headers.cookie, '__Host-spott_ops')
      : undefined;
    const authorization = request.headers.authorization !== undefined
      ? request.headers.authorization
      : cookieToken !== undefined
        ? `Bearer ${cookieToken}`
        : undefined;
    if (authorization === undefined) {
      const demoUser = request.headers['x-spott-user-id'];
      if (devHeaderAuthEnabled(configuration()) && typeof demoUser === 'string') {
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

    const token = this.bearerToken(authorization);
    let claims: AccessClaims;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET),
        { algorithms: ['HS256'], issuer: 'spott-api', audience: 'spott-clients' },
      );
      claims = verified.payload as unknown as AccessClaims;
    } catch {
      throw new UnauthorizedException('TOKEN_EXPIRED');
    }

    const user = await this.sessionAuthority.authorize(
      { sub: claims.sub, sid: claims.sid },
      isOpsRoute ? 'ops' : 'consumer',
    );
    if (!user) throw new UnauthorizedException('TOKEN_EXPIRED');
    request.user = user;
    return true;
  }

  private isUnsafeMethod(method: string): boolean {
    return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  }

  private assertOpsMutationMetadata(request: SpottRequest): void {
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    const fetchMode = request.headers['sec-fetch-mode'];
    const fetchDestination = request.headers['sec-fetch-dest'];
    if (
      typeof origin !== 'string'
      || !configuration().OPS_ORIGIN.includes(origin)
      || fetchSite !== 'same-site'
      || fetchMode !== 'cors'
      || fetchDestination !== 'empty'
    ) {
      throw new ForbiddenException('OPS_REQUEST_METADATA_INVALID');
    }
  }

  private bearerToken(authorization: unknown): string {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('TOKEN_INVALID');
    }
    const token = authorization.slice('Bearer '.length);
    const segments = token.split('.');
    if (
      segments.length !== 3
      || segments.some((segment) => segment.length === 0 || /[^A-Za-z0-9_-]/u.test(segment))
    ) {
      throw new UnauthorizedException('TOKEN_INVALID');
    }
    return token;
  }

  private cookie(header: unknown, name: string): string | undefined {
    if (header === undefined) return undefined;
    if (typeof header !== 'string') throw new UnauthorizedException('TOKEN_INVALID');

    const values: string[] = [];
    for (const rawPart of header.split(';')) {
      const part = rawPart.trim();
      const separator = part.indexOf('=');
      const rawName = separator === -1 ? part : part.slice(0, separator);
      if (rawName.trim() !== name) continue;
      if (separator === -1 || rawName !== name) {
        throw new UnauthorizedException('TOKEN_INVALID');
      }
      values.push(part.slice(separator + 1));
    }
    if (values.length === 0) return undefined;
    if (values.length !== 1) throw new UnauthorizedException('TOKEN_INVALID');

    try {
      return decodeURIComponent(values[0] ?? '');
    } catch {
      throw new UnauthorizedException('TOKEN_INVALID');
    }
  }
}
