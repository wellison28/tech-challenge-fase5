import type { FastifyReply, FastifyRequest } from 'fastify';
import { JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';
import { Env } from '../../config/env';

export interface AuthenticatedPrincipal {
  subject: string;
  /** Grupos do Cognito: `admin` (equipe da revenda) e `customer` (comprador). */
  roles: string[];
  /** Escopos OAuth2 — usados na comunicação máquina-a-máquina com o sales-service. */
  scopes: string[];
  clientId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
  }
}

export class UnauthorizedError extends Error {
  readonly httpStatus = 401;
  readonly code = 'UNAUTHORIZED';
}

export class ForbiddenError extends Error {
  readonly httpStatus = 403;
  readonly code = 'FORBIDDEN';
}

/**
 * Verificador de token.
 *
 * Em produção a assinatura RS256 é conferida contra o JWKS do User Pool do
 * Cognito — a chave pública é buscada e cacheada pelo `jose`, e a rotação de
 * chaves feita pela AWS é absorvida sem deploy. O modo `dev` existe apenas
 * para rodar a stack localmente sem depender da nuvem e é recusado quando
 * NODE_ENV=production (ver `loadEnv`).
 */
export function createTokenVerifier(env: Env) {
  const jwks =
    env.AUTH_MODE === 'cognito' && env.COGNITO_ISSUER
      ? createRemoteJWKSet(new URL(`${env.COGNITO_ISSUER}/.well-known/jwks.json`))
      : undefined;

  const devSecret =
    env.AUTH_MODE === 'dev' && env.JWT_DEV_SECRET
      ? new TextEncoder().encode(env.JWT_DEV_SECRET)
      : undefined;

  return async function verify(token: string): Promise<AuthenticatedPrincipal> {
    let payload: JWTPayload;

    if (jwks) {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: env.COGNITO_ISSUER,
        algorithms: ['RS256'],
      }));
      // `client_credentials` não tem audience; tokens de usuário têm.
      const audience = payload.aud ?? payload.client_id;
      if (env.COGNITO_CLIENT_ID && audience !== env.COGNITO_CLIENT_ID) {
        const audiences = Array.isArray(payload.aud) ? payload.aud : [];
        if (!audiences.includes(env.COGNITO_CLIENT_ID)) {
          throw new UnauthorizedError('Token emitido para outro cliente');
        }
      }
    } else if (devSecret) {
      ({ payload } = await jwtVerify(token, devSecret, { algorithms: ['HS256'] }));
    } else {
      throw new UnauthorizedError('Verificação de token não configurada');
    }

    const groups = (payload['cognito:groups'] as string[] | undefined) ?? [];
    const roles = (payload['roles'] as string[] | undefined) ?? groups;
    const scopes =
      typeof payload['scope'] === 'string' ? (payload['scope'] as string).split(' ') : [];

    if (!payload.sub) {
      throw new UnauthorizedError('Token sem identificador de sujeito');
    }

    return {
      subject: payload.sub,
      roles,
      scopes,
      ...(typeof payload['client_id'] === 'string' ? { clientId: payload['client_id'] } : {}),
    };
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

export function authenticate(verify: TokenVerifier) {
  return async function hook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Cabeçalho Authorization: Bearer <token> ausente');
    }
    try {
      request.principal = await verify(header.slice('Bearer '.length).trim());
    } catch (error) {
      request.log.warn({ err: error }, 'falha na verificação do token');
      throw new UnauthorizedError('Token inválido ou expirado');
    }
  };
}

/**
 * Autorização por papel/escopo, aplicada por rota.
 *
 * O princípio é o do menor privilégio: o catálogo é leitura pública, o cadastro
 * exige `admin`, e os passos da SAGA exigem escopo de máquina — um token de
 * comprador não consegue confirmar a venda de um veículo mesmo que descubra a URL.
 */
export function authorize(requirements: { roles?: string[]; scopes?: string[] }) {
  return async function hook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const principal = request.principal;
    if (!principal) {
      throw new UnauthorizedError('Requisição não autenticada');
    }

    const hasRole = requirements.roles?.some((role) => principal.roles.includes(role)) ?? false;
    const hasScope = requirements.scopes?.some((s) => principal.scopes.includes(s)) ?? false;

    if (!hasRole && !hasScope) {
      request.log.warn(
        { subject: principal.subject, required: requirements },
        'acesso negado por política de autorização',
      );
      throw new ForbiddenError('Credencial sem permissão para esta operação');
    }
  };
}
