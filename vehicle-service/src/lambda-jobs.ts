import { buildContainer } from './infrastructure/container';

/**
 * Funções agendadas do serviço, empacotadas junto da API.
 *
 * São dois processos de background que sustentam garantias que o caminho
 * síncrono não consegue dar sozinho:
 *
 *  - `expireReservationsHandler`: devolve ao estoque reservas vencidas cuja
 *    SAGA morreu no meio. Garantia de liveness do estoque.
 *  - `publishOutboxHandler`: entrega ao EventBridge os eventos gravados na
 *    mesma transação da mudança de estado. Garantia de durabilidade da
 *    notificação (at-least-once).
 */
const container = buildContainer();

export async function expireReservationsHandler(): Promise<{
  scanned: number;
  released: number;
  skippedByConcurrency: number;
}> {
  const result = await container.useCases.expireReservations.execute();
  container.logger.info(result, 'expiração de reservas concluída');
  return result;
}

export async function publishOutboxHandler(): Promise<{
  fetched: number;
  published: number;
  failed: number;
}> {
  const result = await container.useCases.publishOutbox.execute();
  if (result.failed > 0) {
    container.logger.error(result, 'falha ao publicar eventos do outbox');
    // Lança para a Lambda ser marcada como erro e o alarme do CloudWatch disparar.
    throw new Error(`Falha ao publicar ${result.failed} evento(s) do outbox`);
  }
  container.logger.info(result, 'outbox despachado');
  return result;
}
