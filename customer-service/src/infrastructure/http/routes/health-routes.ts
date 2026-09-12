import type { FastifyInstance } from 'fastify';
import { Container } from '../../container';

export async function healthRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.get('/health', { logLevel: 'warn' }, async () => ({
    status: 'ok',
    service: container.env.SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  /**
   * Readiness verifica banco **e** criptografia.
   *
   * Se o KMS estiver inacessível ou a política da chave tiver sido alterada, o
   * serviço sobe e responde 200 no liveness, mas falharia em toda escrita. É
   * melhor sair do balanceador do que aceitar tráfego que vai falhar.
   */
  app.get('/health/ready', { logLevel: 'warn' }, async (_request, reply) => {
    const dependencies: Record<string, 'up' | 'down'> = { database: 'down', crypto: 'down' };

    try {
      await container.prisma.$queryRaw`SELECT 1`;
      dependencies.database = 'up';
    } catch (error) {
      container.logger.error({ err: error }, 'readiness: banco indisponível');
    }

    try {
      const probe = await container.cipher.encrypt('readiness-probe', {
        customerId: '00000000-0000-0000-0000-000000000000',
        field: 'healthcheck',
      });
      await container.cipher.decrypt(probe, {
        customerId: '00000000-0000-0000-0000-000000000000',
        field: 'healthcheck',
      });
      dependencies.crypto = 'up';
    } catch (error) {
      container.logger.error({ err: error }, 'readiness: criptografia indisponível');
    }

    const ready = Object.values(dependencies).every((state) => state === 'up');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      dependencies,
    });
  });
}
