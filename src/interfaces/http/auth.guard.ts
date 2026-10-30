import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProviderMismatchError } from '../../application/errors';
import type { AppConfig } from '../../infrastructure/config/env';
import {
  ADMIN_PRINCIPAL_FOR_DISABLED_AUTH,
  InvalidTokenError,
  JwtVerifier,
  type Principal,
} from '../../infrastructure/auth/jwt-verifier';
import { APP_CONFIG } from './tokens';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

/** Rota sem autenticação (health, métricas). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
/** Exige ao menos um dos papéis do realm. */
export const RequireAnyRole = (...roles: string[]) => SetMetadata(REQUIRED_ROLES, roles);

export type AuthenticatedRequest = Request & { principal?: Principal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtVerifier) private readonly verifier: JwtVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.config.auth.enabled) {
      request.principal = ADMIN_PRINCIPAL_FOR_DISABLED_AUTH;
      return true;
    }
    const header = request.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Bearer token required' });
    }
    try {
      request.principal = await this.verifier.verify(token);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid or expired token' });
      }
      throw err;
    }
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, targets) ?? [];
    if (required.length > 0 && !required.some((role) => request.principal!.roles.includes(role))) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Requires one of roles: ${required.join(', ')}` });
    }
    return true;
  }
}

/**
 * ProviderIdentityPort na prática: um provedor só age em nome de si mesmo. Administradores podem
 * consultar qualquer provedor, mas nunca submeter transações em nome de um.
 */
export function assertActsAsProvider(principal: Principal | undefined, providerId: string, adminRole: string, allowAdmin: boolean): void {
  if (!principal) {
    throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Not authenticated' });
  }
  if (principal === ADMIN_PRINCIPAL_FOR_DISABLED_AUTH) {
    return;
  }
  if (allowAdmin && principal.roles.includes(adminRole)) {
    return;
  }
  if (principal.providerId !== providerId) {
    throw new ProviderMismatchError(principal.providerId ?? principal.clientId ?? 'unknown', providerId);
  }
}
