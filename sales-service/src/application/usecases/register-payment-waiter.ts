import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

/**
 * Task do estado `AguardarPagamento`.
 *
 * Recebe o `taskToken` do Step Functions e o grava no pedido. A partir daí a
 * execução fica suspensa — sem consumir computação — até que o webhook do
 * provedor (ou o cancelamento pelo cliente) devolva o token.
 *
 * Guardar o token no banco, e não em memória, é o que torna a espera resistente
 * a reinício: a Lambda que recebeu o token morre logo depois, e o webhook pode
 * chegar em outra instância, horas mais tarde.
 */
export class RegisterPaymentWaiterUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(params: { orderId: string; taskToken: string }): Promise<{ registered: boolean }> {
    return this.uow.execute(async (ctx) => {
      const order = await ctx.orders.findById(params.orderId);
      if (!order) {
        throw new NotFoundError('Pedido', params.orderId);
      }

      const version = order.version;
      order.attachSagaTaskToken(params.taskToken, this.clock.now());

      if (!(await ctx.orders.update(order, version))) {
        throw new ConflictError('Conflito de concorrência ao registrar o token de callback', {
          orderId: params.orderId,
        });
      }

      return { registered: true };
    });
  }
}
