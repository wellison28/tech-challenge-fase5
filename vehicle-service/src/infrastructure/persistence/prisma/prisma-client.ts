import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma reaproveitado entre invocações da Lambda.
 *
 * O container da Lambda sobrevive a várias requisições; criar um PrismaClient
 * por invocação esgotaria o pool de conexões do banco. Mantemos uma instância
 * no escopo do módulo e, em produção, apontamos a DATABASE_URL para o RDS
 * Proxy, que multiplexa as conexões das Lambdas em poucas conexões reais no
 * Aurora — o padrão recomendado para bancos relacionais em serverless.
 */
let client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
