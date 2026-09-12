import { buildApp } from './app';
import { buildContainer } from '../container';
import { disconnectPrisma } from '../persistence/prisma/prisma-client';

/** Entrypoint para execução como contêiner/processo (docker-compose, ECS, local). */
async function main(): Promise<void> {
  const container = buildContainer();
  const app = await buildApp(container);

  const shutdown = async (signal: string): Promise<void> => {
    container.logger.info({ signal }, 'encerrando o serviço');
    // Fecha o servidor antes do banco: requisições em voo terminam com conexão válida.
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: container.env.PORT, host: '0.0.0.0' });
  container.logger.info(
    { port: container.env.PORT, docs: `http://localhost:${container.env.PORT}/docs` },
    'sales-service no ar',
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('falha ao iniciar o sales-service', error);
  process.exit(1);
});
