import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { buildIamPoolConfig } from './iam-connection';

/**
 * Cliente Prisma reaproveitado entre invocações da Lambda.
 *
 * O container da Lambda sobrevive a várias requisições; criar um PrismaClient
 * por invocação esgotaria o pool de conexões do banco. Mantemos uma instância
 * no escopo do módulo e, em produção, apontamos a DATABASE_URL para o RDS
 * Proxy, que multiplexa as conexões das Lambdas em poucas conexões reais no
 * Aurora — o padrão recomendado para bancos relacionais em serverless.
 *
 * Com `DB_AUTH_MODE=iam` (produção) a conexão não usa senha: o Prisma recebe um
 * pool `pg` que gera um token IAM a cada conexão aberta com o Proxy (ver
 * `iam-connection.ts`). Em desenvolvimento e testes vale a senha da DATABASE_URL.
 */
let client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!client) {
    const log: ('warn' | 'error')[] =
      process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

    client =
      process.env.DB_AUTH_MODE === 'iam'
        ? new PrismaClient({ adapter: new PrismaPg(new Pool(iamPoolConfig())), log })
        : new PrismaClient({ log });
  }
  return client;
}

function iamPoolConfig() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não definida');
  }
  // A Lambda define AWS_REGION automaticamente.
  return buildIamPoolConfig(databaseUrl, process.env.AWS_REGION ?? 'us-east-1');
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
