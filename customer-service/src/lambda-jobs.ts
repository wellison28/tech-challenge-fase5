import { buildContainer } from './infrastructure/container';

const bootstrap = buildContainer();

/** Entrega ao EventBridge os eventos gravados no outbox. */
export async function publishOutboxHandler(): Promise<{
  fetched: number;
  published: number;
  failed: number;
}> {
  const container = await bootstrap;
  const result = await container.useCases.publishOutbox.execute();

  if (result.failed > 0) {
    container.logger.error(result, 'falha ao publicar eventos do outbox');
    throw new Error(`Falha ao publicar ${result.failed} evento(s) do outbox`);
  }
  container.logger.info(result, 'outbox despachado');
  return result;
}
