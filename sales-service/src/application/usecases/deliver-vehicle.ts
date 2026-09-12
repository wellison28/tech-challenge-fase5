import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { OrderEventType, OrderPayload } from '../../domain/events/domain-event';
import { OrderDTO, toOrderDTO } from '../dto/order-dto';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

/**
 * Passo 6 — retirada do veículo pelo cliente.
 *
 * Encerra o processo. A partir daqui o pedido é terminal e não admite
 * cancelamento pela SAGA: uma devolução depois da entrega é um processo de
 * negócio distinto (garantia, arrependimento), com regras e prazos próprios,
 * e não uma compensação técnica.
 */
export class DeliverVehicleUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
  ) {}

  async execute(params: { orderId: string; correlationId: string }): Promise<OrderDTO> {
    return this.uow.execute(async (ctx) => {
      const order = await ctx.orders.findById(params.orderId);
      if (!order) {
        throw new NotFoundError('Pedido', params.orderId);
      }

      const version = order.version;
      const alreadyDelivered = order.deliveredAt !== null;
      order.markDelivered(this.clock.now());

      if (!(await ctx.orders.update(order, version))) {
        throw new ConflictError('Conflito de concorrência ao registrar a retirada', {
          orderId: order.id,
        });
      }

      if (!alreadyDelivered) {
        await ctx.outbox.enqueue(
          this.events.build<OrderPayload>(
            OrderEventType.COMPLETED,
            order.id,
            {
              orderId: order.id,
              customerId: order.customerId,
              vehicleId: order.vehicleId,
              status: order.status,
            },
            params.correlationId,
          ),
        );
      }

      return toOrderDTO(order, { includePaymentCode: false });
    });
  }
}
