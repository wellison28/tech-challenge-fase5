import { Signer } from '@aws-sdk/rds-signer';
import type { PoolConfig } from 'pg';

export interface AuthTokenRequest {
  hostname: string;
  port: number;
  username: string;
  region: string;
}

export type AuthTokenProvider = (request: AuthTokenRequest) => Promise<string>;

const signerToken: AuthTokenProvider = (request) => new Signer(request).getAuthToken();

/**
 * Configuração do pool `pg` para conectar ao RDS Proxy com token IAM.
 *
 * O token substitui a senha e vale 15 minutos — mas só para **abrir** a
 * conexão. Como o pool abre conexões novas ao longo da vida do container da
 * Lambda, a senha é uma função: cada conexão nova pede um token novo. Gerar o
 * token é uma assinatura SigV4 local com as credenciais do papel da Lambda, sem
 * chamada de rede.
 *
 * A DATABASE_URL traz apenas usuário, host, porta e banco — nenhuma senha.
 */
export function buildIamPoolConfig(
  databaseUrl: string,
  region: string,
  tokenFor: AuthTokenProvider = signerToken,
): PoolConfig {
  const url = new URL(databaseUrl);
  const hostname = url.hostname;
  const port = Number(url.port || 5432);
  const username = decodeURIComponent(url.username);

  if (!username) {
    throw new Error('DB_AUTH_MODE=iam exige o usuário na DATABASE_URL');
  }
  if (url.password) {
    throw new Error('DB_AUTH_MODE=iam não aceita senha na DATABASE_URL');
  }

  return {
    host: hostname,
    port,
    user: username,
    database: decodeURIComponent(url.pathname.slice(1)),
    // O Proxy exige TLS (`require_tls`), com certificado de CA pública.
    ssl: { rejectUnauthorized: true },
    password: () => tokenFor({ hostname, port, username, region }),
  };
}
