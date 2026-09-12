import { buildContainer } from './infrastructure/container';
import { CancellationReason } from './domain/entities/order';

/**
 * Handlers invocados como **Lambda Tasks** pela máquina de estados do Step
 * Functions (`infra/statemachine/purchase-saga.asl.json`).
 *
 * Cada função é um passo da SAGA. Elas não decidem o que vem depois: quem
 * conhece a ordem, o retry e a rota de compensação é a máquina de estados.
 * Essa separação é o ponto central da orquestração — a lógica de coordenação
 * fica declarada e visível em um só lugar, em vez de espalhada pelos serviços.
 *
 * O container é criado uma vez por container de execução e reaproveitado entre
 * invocações.
 */
const container = buildContainer();

export interface SagaTaskEvent {
  orderId: string;
  correlationId: string;
  /** Preenchido pela máquina de estados no ramo de compensação. */
  reason?: CancellationReason;
  detail?: string;
}

export async function reserveVehicleTask(event: SagaTaskEvent) {
  return container.steps.reserveVehicle(event);
}

export async function validateCustomerTask(event: SagaTaskEvent) {
  return container.steps.validateCustomer(event);
}

export async function createPaymentTask(event: SagaTaskEvent) {
  return container.steps.createPayment(event);
}

/**
 * Task do estado `AguardarPagamento`. Grava o `taskToken` no pedido e retorna
 * sem responder ao Step Functions — a execução fica suspensa até o webhook ou
 * o cancelamento devolverem o token.
 */
export async function registerPaymentWaiterTask(event: SagaTaskEvent & { taskToken: string }) {
  return container.useCases.registerPaymentWaiter.execute({
    orderId: event.orderId,
    taskToken: event.taskToken,
  });
}

export async function confirmSaleTask(event: SagaTaskEvent) {
  return container.steps.confirmSale(event);
}

export async function compensateTask(event: SagaTaskEvent) {
  return container.steps.compensate({
    orderId: event.orderId,
    correlationId: event.correlationId,
    reason: event.reason ?? CancellationReason.SYSTEM_FAILURE,
    ...(event.detail ? { detail: event.detail } : {}),
  });
}

/**
 * Varredura agendada (EventBridge Scheduler, a cada minuto).
 *
 * Confere no provedor as cobranças cuja janela venceu antes de compensar —
 * webhook perdido não pode custar a venda a um cliente que pagou.
 */
export async function expireOrdersTask() {
  const result = await container.useCases.expireOrders.execute();
  container.logger.info(result, 'varredura de pedidos vencidos concluída');
  return result;
}

/** Despacha os eventos do outbox para o EventBridge. */
export async function publishOutboxTask() {
  const result = await container.useCases.publishOutbox.execute();
  if (result.failed > 0) {
    container.logger.error(result, 'falha ao publicar eventos do outbox');
    throw new Error(`Falha ao publicar ${result.failed} evento(s) do outbox`);
  }
  return result;
}
