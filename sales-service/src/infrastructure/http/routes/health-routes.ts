import type { FastifyInstance } from 'fastify';
import { Container } from '../../container';

export async function healthRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.get('/health', { logLevel: 'warn' }, async () => ({
    status: 'ok',
    service: container.env.SERVICE_NAME,
    sagaMode: container.env.SAGA_MODE,
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', { logLevel: 'warn' }, async (_request, reply) => {
    try {
      await container.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', dependencies: { database: 'up' } };
    } catch (error) {
      container.logger.error({ err: error }, 'readiness falhou');
      return reply.status(503).send({ status: 'degraded', dependencies: { database: 'down' } });
    }
  });
}
