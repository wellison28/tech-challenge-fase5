/**
 * Dispara a execução da SAGA.
 *
 * A abstração existe para que o caso de uso de iniciar a compra não saiba se a
 * orquestração acontece no Step Functions ou dentro do próprio processo. Trocar
 * de modo é configuração (`SAGA_MODE`), não alteração de código de negócio.
 */
export interface SagaLauncherPort {
  start(params: { orderId: string; correlationId: string }): Promise<{ executionRef: string }>;
}
