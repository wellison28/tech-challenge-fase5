import { CancellationReason } from '../../domain/entities/order';
import { PurchaseSagaSteps } from '../saga/steps';
import { Clock } from '../ports/clock';
import { PaymentGatewayPort, PaymentChargeStatus } from '../ports/payment-gateway';
import { UnitOfWork } from '../ports/unit-of-work';

export interface ExpireOrdersResult {
  scanned: number;
  compensated: number;
  rescuedByReconciliation: number;
  failures: number;
}

/**
 * Varredura das compras cuja janela de pagamento venceu.
 *
 * Antes de compensar, **confere ativamente** o status da cobrança no provedor.
 * Webhook é entrega não confiável: se a notificação de pagamento se perdeu, o
 * cliente pagou e ficaria sem o carro — e com uma cobrança a estornar. Essa
 * conferência é o que transforma o webhook em otimização de latência em vez de
 * um ponto único de falha.
 *
 * Roda por EventBridge Scheduler, a cada minuto.
 */
export class ExpireOrdersUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly steps: PurchaseSagaSteps,
    private readonly payments: PaymentGatewayPort,
    private readonly batchSize = 25,
  ) {}

  async execute(): Promise<ExpireOrdersResult> {
    const now = this.clock.now();
    const candidates = await this.uow.execute((ctx) =>
      ctx.orders.findExpiredAwaitingPayment(now, this.batchSize),
    );

    let compensated = 0;
    let rescuedByReconciliation = 0;
    let failures = 0;

    for (const order of candidates) {
      const correlationId = `expire-${order.id}`;

      try {
        if (order.paymentChargeId) {
          const charge = await this.payments.getCharge({
            chargeId: order.paymentChargeId,
            correlationId,
          });

          if (charge.status === PaymentChargeStatus.PAID) {
            // O cliente pagou; o aviso é que não chegou. Conclui a venda.
            try {
              await this.steps.settleReconciledPayment({ orderId: order.id, correlationId });
              rescuedByReconciliation += 1;
              continue;
            } catch (error) {
              // A reserva caiu no intervalo e o veículo não está mais
              // disponível: não há venda a concluir, e sim dinheiro a devolver.
              await this.steps.compensate({
                orderId: order.id,
                correlationId,
                reason: CancellationReason.PAYMENT_TIMEOUT,
                detail: `Pagamento confirmado, mas a baixa foi recusada: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
              compensated += 1;
              continue;
            }
          }
        }

        await this.steps.compensate({
          orderId: order.id,
          correlationId,
          reason: CancellationReason.PAYMENT_TIMEOUT,
          detail: 'Janela de pagamento encerrada sem confirmação',
        });
        compensated += 1;
      } catch {
        // Uma falha isolada não pode interromper o lote: o pedido permanece
        // elegível e será retomado na próxima execução.
        failures += 1;
      }
    }

    return { scanned: candidates.length, compensated, rescuedByReconciliation, failures };
  }
}
