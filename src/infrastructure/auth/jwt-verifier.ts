import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config/env';

/** Quem está chamando, já autenticado pelo IdP. */
export interface Principal {
  subject: string;
  clientId: string | undefined;
  /** Presente quando o token é de um provedor de jogos (claim provider_id). */
  providerId: string | undefined;
  roles: string[];
}

export const ADMIN_PRINCIPAL_FOR_DISABLED_AUTH: Principal = {
  subject: 'auth-disabled',
  clientId: undefined,
  providerId: undefined,
  roles: ['wallet-admin', 'provider'],
};

export class InvalidTokenError extends Error {}

/**
 * Valida JWTs emitidos pelo Keycloak localmente, pelo JWKS (chaves em cache, renovadas quando aparece
 * um `kid` desconhecido). Não há chamada ao IdP por requisição.
 */
export class JwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: AppConfig['auth']) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { issuer: this.config.issuer, clockTolerance: 5 }));
    } catch (err) {
      throw new InvalidTokenError(err instanceof Error ? err.message : 'invalid token');
    }
    const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles.filter((r): r is string => typeof r === 'string') : [];
    return {
      subject: payload.sub ?? 'unknown',
      clientId: typeof payload.azp === 'string' ? payload.azp : undefined,
      providerId: typeof payload.provider_id === 'string' ? payload.provider_id : undefined,
      roles,
    };
  }
}
