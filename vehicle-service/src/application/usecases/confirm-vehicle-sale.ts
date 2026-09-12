import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { VehicleEventType, VehicleSoldPayload } from '../../domain/events/domain-event';
import { VehicleDTO, toVehicleDTO } from '../dto/vehicle-dto';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface ConfirmVehicleSaleCommand {
  vehicleId: string;
  orderId: string;
  customerId: string;
  correlationId: string;
}

/**
 * Passo final da SAGA: baixa do veículo no estoque após a confirmação do
 * pagamento. Exige reserva ativa e vigente do MESMO pedido — uma confirmação
 * que chegue depois da expiração é recusada com 409 e a SAGA segue para o
 * fluxo de estorno, em vez de vender um carro que já voltou à vitrine.
 */
export class ConfirmVehicleSaleUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
  ) {}

  async execute(command: ConfirmVehicleSaleCommand): Promise<VehicleDTO> {
    return this.uow.execute(async (ctx) => {
      const vehicle = await ctx.vehicles.findById(command.vehicleId);
      if (!vehicle) {
        throw new NotFoundError('Veículo', command.vehicleId);
      }

      // Reexecução do mesmo passo: devolve o estado atual sem novo evento.
      if (vehicle.sale?.orderId === command.orderId) {
        return toVehicleDTO(vehicle);
      }

      const versionBeforeUpdate = vehicle.version;
      const now = this.clock.now();
      vehicle.confirmSale({
        orderId: command.orderId,
        customerId: command.customerId,
        now,
      });

      const applied = await ctx.vehicles.update(vehicle, versionBeforeUpdate);
      if (!applied) {
        throw new ConflictError('Conflito de concorrência ao confirmar a venda', {
          vehicleId: vehicle.id,
        });
      }

      await ctx.outbox.enqueue(
        this.events.build<VehicleSoldPayload & Record<string, unknown>>(
          VehicleEventType.SOLD,
          vehicle.id,
          {
            vehicleId: vehicle.id,
            orderId: command.orderId,
            customerId: command.customerId,
            soldPriceInCents: vehicle.sale?.soldPrice.cents ?? vehicle.price.cents,
            soldAt: now.toISOString(),
          },
          { correlationId: command.correlationId, orderId: command.orderId },
        ),
      );

      return toVehicleDTO(vehicle);
    });
  }
}
