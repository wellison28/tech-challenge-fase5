import { Order } from '../../domain/entities/order';
import { ConflictError } from '../../domain/errors/domain-error';
import { OrderEventType, OrderPayload } from '../../domain/events/domain-event';
import { OrderDTO, toOrderDTO } from '../dto/order-dto';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { IdGenerator } from '../ports/id-generator';
import { SagaLauncherPort } from '../ports/saga-launcher';
import { UnitOfWork } from '../ports/unit-of-work';

export interface StartPurchaseCommand {
  customerId: string;
  vehicleId: string;
  correlationId: string;
}

/**
 * Início do processo de compra: o cliente selecionou um veículo.
 *
 * Cria o pedido em `PENDING` e dispara a SAGA. A criação e o disparo são
 * separados de propósito: se o disparo falhar, o pedido já existe em banco e é
 * recuperável pelo processo de reconciliação — em vez de a compra
 * simplesmente desaparecer.
 */
export class StartPurchaseUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly saga: SagaLauncherPort,
  ) {}

  async execute(command: StartPurchaseCommand): Promise<OrderDTO> {
    const order = await this.uow.execute(async (ctx) => {
      // Duplo clique no botão "reservar" abriria duas SAGAs para a mesma
      // compra; a segunda perderia a disputa contra a primeira e o cliente
      // veria um erro incompreensível.
      const existing = await ctx.orders.findActiveByCustomerAndVehicle(
        command.customerId,
        command.vehicleId,
      );
      if (existing) {
        throw new ConflictError('Já existe um pedido em andamento para este veículo', {
          orderId: existing.id,
          status: existing.status,
        });
      }

      const created = Order.create({
        id: this.ids.generate(),
        customerId: command.customerId,
        vehicleId: command.vehicleId,
        now: this.clock.now(),
      });

      await ctx.orders.create(created);
      await ctx.outbox.enqueue(
        this.events.build<OrderPayload>(
          OrderEventType.STARTED,
          created.id,
          {
            orderId: created.id,
            customerId: created.customerId,
            vehicleId: created.vehicleId,
            status: created.status,
          },
          command.correlationId,
        ),
      );

      return created;
    });

    await this.saga.start({ orderId: order.id, correlationId: command.correlationId });

    // Relê o pedido: a SAGA em modo inline já avançou o estado.
    const current = await this.uow.execute((ctx) => ctx.orders.findById(order.id));
    return toOrderDTO(current ?? order, { includePaymentCode: true });
  }
}
