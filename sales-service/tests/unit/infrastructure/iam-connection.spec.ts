import { describe, expect, it } from 'vitest';
import {
  AuthTokenRequest,
  buildIamPoolConfig,
} from '../../../src/infrastructure/persistence/prisma/iam-connection';

const PROXY_URL =
  'postgresql://sales_service_app@revenda-prod-sales-proxy.proxy-abc.us-east-1.rds.amazonaws.com:5432/sales?schema=public&sslmode=require';

describe('conexão ao banco por token IAM', () => {
  it('extrai host, porta, usuário e banco da DATABASE_URL e exige TLS', () => {
    const config = buildIamPoolConfig(PROXY_URL, 'us-east-1', async () => 'token');

    expect(config).toMatchObject({
      host: 'revenda-prod-sales-proxy.proxy-abc.us-east-1.rds.amazonaws.com',
      port: 5432,
      user: 'sales_service_app',
      database: 'sales',
      ssl: { rejectUnauthorized: true },
    });
  });

  it('pede um token novo a cada conexão aberta', async () => {
    const requests: AuthTokenRequest[] = [];
    const config = buildIamPoolConfig(PROXY_URL, 'us-east-1', async (request) => {
      requests.push(request);
      return `token-${requests.length}`;
    });
    const password = config.password as () => Promise<string>;

    expect(await password()).toBe('token-1');
    expect(await password()).toBe('token-2');
    expect(requests[0]).toEqual({
      hostname: 'revenda-prod-sales-proxy.proxy-abc.us-east-1.rds.amazonaws.com',
      port: 5432,
      username: 'sales_service_app',
      region: 'us-east-1',
    });
  });

  it('recusa DATABASE_URL com senha embutida', () => {
    expect(() =>
      buildIamPoolConfig('postgresql://app:senha@proxy.local:5432/sales', 'us-east-1'),
    ).toThrow(/não aceita senha/);
  });
});
