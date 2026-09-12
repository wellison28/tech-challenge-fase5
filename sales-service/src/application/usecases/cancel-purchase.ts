import { CancellationReason } from '../../domain/entities/order';
import { NotFoundError } from '../../domain/errors/domain-error';
import { OrderDTO, toOrderDTO } from '../dto/order-dto';
import { Clock } from '../ports/clock';
import { SagaCallbackPort } from '../ports/saga-callback';
import { UnitOfWork } from '../ports/unit-of-work';
import { PurchaseSagaSteps } from '../saga/steps';

/**
 * Desistência do cliente, em qualquer etapa antes da conclusão.
 *
 * É o cenário explícito do enunciado ("o cliente desiste da compra em qualquer
 * um dos passos"). Se existir uma execução suspensa aguardando o pagamento, ela
 * é retomada com o erro `ClienteDesistiu`, e a própria máquina de estados
 * conduz a compensação — em vez de duas rotas concorrentes desfazendo o mesmo
 * pedido. Sem execução suspensa, a compensação é chamada diretamente.
 */
export class CancelPurchaseUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly steps: PurchaseSagaSteps,
    private readonly callback: SagaCallbackPort,
  ) {}

  async execute(params: {
    orderId: string;
    requestedBy: string;
    correlationId: string;
  }): Promise<OrderDTO> {
    const order = await this.uow.execute((ctx) => ctx.orders.findById(params.orderId));
    if (!order) {
      throw new NotFoundError('Pedido', params.orderId);
    }
    if (order.isTerminal) {
      return toOrderDTO(order, { includePaymentCode: false });
    }

    const token = await this.uow.execute(async (ctx) => {
      const current = await ctx.orders.findById(params.orderId);
      if (!current) return null;

      const version = current.version;
      const consumed = current.consumeSagaTaskToken(this.clock.now());
      if (!consumed) return null;

      return (await ctx.orders.update(current, version)) ? consumed : null;
    });

    if (token) {
      await this.callback.fail({
        taskToken: token,
        error: 'ClienteDesistiu',
        cause: `Cancelado a pedido de ${params.requestedBy}`,
      });
    } else {
      await this.steps.compensate({
        orderId: params.orderId,
        correlationId: params.correlationId,
        reason: CancellationReason.CUSTOMER_GAVE_UP,
        detail: `Cancelado a pedido de ${params.requestedBy}`,
      });
    }

    const current = await this.uow.execute((ctx) => ctx.orders.findById(params.orderId));
    return toOrderDTO(current ?? order, { includePaymentCode: false });
  }
}
