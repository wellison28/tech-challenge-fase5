import { CancellationReason } from '../../domain/entities/order';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { OrderEventType, OrderPayload } from '../../domain/events/domain-event';
import { OrderDTO, toOrderDTO } from '../dto/order-dto';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { SagaCallbackPort } from '../ports/saga-callback';
import { UnitOfWork } from '../ports/unit-of-work';
import { PurchaseSagaSteps } from '../saga/steps';

export interface ConfirmPaymentCommand {
  chargeId: string;
  /** `PAID` confirma; `REFUSED` e `EXPIRED` levam à compensação. */
  outcome: 'PAID' | 'REFUSED' | 'EXPIRED';
  correlationId: string;
}

/**
 * Retomada da SAGA pelo webhook do provedor de pagamento.
 *
 * Este é o ponto de espera do processo. Quando a orquestração roda no Step
 * Functions, existe uma execução suspensa em `waitForTaskToken`, e o caminho
 * correto é devolver o token — deixando a máquina de estados decidir o que vem
 * a seguir. Quando não há token (modo inline, ou execução já encerrada), o
 * próprio caso de uso dá sequência.
 *
 * Webhook é entrega ao-menos-uma-vez e fora de ordem, então tudo aqui é
 * idempotente: reprocessar o mesmo aviso não muda nada.
 *
 * Um pagamento confirmado **depois** do prazo não conclui a venda: nesse
 * intervalo a reserva pode ter expirado e o veículo ter sido vendido a outro
 * comprador. O fluxo correto é compensar com estorno.
 */
export class ConfirmPaymentUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly steps: PurchaseSagaSteps,
    private readonly callback: SagaCallbackPort,
  ) {}

  async execute(command: ConfirmPaymentCommand): Promise<OrderDTO> {
    const order = await this.uow.execute((ctx) =>
      ctx.orders.findByPaymentChargeId(command.chargeId),
    );
    if (!order) {
      throw new NotFoundError('Pedido para a cobrança', command.chargeId);
    }

    if (order.isTerminal) {
      return toOrderDTO(order, { includePaymentCode: false }); // reentrega tardia
    }

    // ---- Pagamento não confirmado: compensar ----
    if (command.outcome !== 'PAID') {
      const reason =
        command.outcome === 'EXPIRED'
          ? CancellationReason.PAYMENT_TIMEOUT
          : CancellationReason.PAYMENT_REFUSED;

      const token = await this.consumeToken(order.id);
      if (token) {
        // Devolve o token com erro nomeado: a máquina de estados casa o nome no
        // `Catch` e registra o motivo correto no pedido.
        await this.callback.fail({
          taskToken: token,
          error: 'PagamentoRecusado',
          cause: `Provedor retornou ${command.outcome}`,
        });
      } else {
        await this.steps.compensate({
          orderId: order.id,
          correlationId: command.correlationId,
          reason,
          detail: `Provedor de pagamento retornou ${command.outcome}`,
        });
      }
      return this.reload(order.id);
    }

    // ---- Pagamento confirmado fora do prazo: estornar ----
    const now = this.clock.now();
    if (order.isPaymentWindowExpired(now)) {
      const token = await this.consumeToken(order.id);
      if (token) {
        await this.callback.fail({
          taskToken: token,
          error: 'PagamentoRecusado',
          cause: 'Pagamento confirmado após o prazo; será estornado',
        });
      } else {
        await this.steps.compensate({
          orderId: order.id,
          correlationId: command.correlationId,
          reason: CancellationReason.PAYMENT_TIMEOUT,
          detail: 'Pagamento confirmado após o prazo; será estornado',
        });
      }
      return this.reload(order.id);
    }

    // ---- Caminho feliz ----
    const token = await this.uow.execute(async (ctx) => {
      const current = await ctx.orders.findById(order.id);
      if (!current) throw new NotFoundError('Pedido', order.id);

      const version = current.version;
      const alreadyPaid = current.paidAt !== null;
      current.markPaid({ now, chargeId: command.chargeId });
      const consumed = current.consumeSagaTaskToken(now);

      if (!(await ctx.orders.update(current, version))) {
        throw new ConflictError('Conflito de concorrência ao confirmar o pagamento', {
          orderId: current.id,
        });
      }

      if (!alreadyPaid) {
        await ctx.outbox.enqueue(
          this.events.build<OrderPayload>(
            OrderEventType.PAID,
            current.id,
            {
              orderId: current.id,
              customerId: current.customerId,
              vehicleId: current.vehicleId,
              status: current.status,
              ...(current.amount ? { amountInCents: current.amount.cents } : {}),
            },
            command.correlationId,
          ),
        );
      }

      return consumed;
    });

    if (token) {
      // O Step Functions segue para `ConfirmarVenda` — inclusive com o retry e
      // a rota de compensação já declarados lá.
      await this.callback.succeed({ taskToken: token, output: { orderId: order.id, paid: true } });
    } else {
      await this.steps.confirmSale({ orderId: order.id, correlationId: command.correlationId });
    }

    return this.reload(order.id);
  }

  /** Lê e apaga o token numa só transação, para que ele não seja usado duas vezes. */
  private async consumeToken(orderId: string): Promise<string | null> {
    return this.uow.execute(async (ctx) => {
      const current = await ctx.orders.findById(orderId);
      if (!current) return null;

      const version = current.version;
      const token = current.consumeSagaTaskToken(this.clock.now());
      if (!token) return null;

      if (!(await ctx.orders.update(current, version))) {
        // Outra requisição consumiu primeiro: não devolver o token evita
        // enviar dois callbacks para a mesma execução.
        return null;
      }
      return token;
    });
  }

  private async reload(orderId: string): Promise<OrderDTO> {
    const current = await this.uow.execute((ctx) => ctx.orders.findById(orderId));
    if (!current) throw new NotFoundError('Pedido', orderId);
    return toOrderDTO(current, { includePaymentCode: false });
  }
}
