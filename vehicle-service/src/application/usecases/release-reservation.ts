import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import {
  VehicleEventType,
  VehicleReservationReleasedPayload,
} from '../../domain/events/domain-event';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface ReleaseReservationCommand {
  vehicleId: string;
  /** Quando informado, só libera se a reserva ativa for esta (evita liberar reserva alheia). */
  reservationId?: string;
  orderId: string;
  reason: VehicleReservationReleasedPayload['reason'];
  correlationId: string;
}

/**
 * Compensação do passo de reserva.
 *
 * Chamada pela SAGA quando o pagamento falha, expira, ou o cliente desiste.
 * É idempotente por construção: liberar um veículo que já está disponível
 * devolve sucesso sem publicar evento, porque o Step Functions pode reexecutar
 * a compensação em caso de retry.
 */
export class ReleaseReservationUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
  ) {}

  async execute(command: ReleaseReservationCommand): Promise<{ released: boolean }> {
    return this.uow.execute(async (ctx) => {
      const vehicle = await ctx.vehicles.findById(command.vehicleId);
      if (!vehicle) {
        throw new NotFoundError('Veículo', command.vehicleId);
      }

      const activeReservation = vehicle.reservation;
      if (!activeReservation) {
        return { released: false };
      }
      if (activeReservation.orderId !== command.orderId) {
        // A reserva ativa já é de outro pedido: nada a compensar neste pedido.
        return { released: false };
      }

      const versionBeforeUpdate = vehicle.version;
      const reservationId = activeReservation.id;
      const released = vehicle.releaseReservation({
        reservationId: command.reservationId ?? reservationId,
        now: this.clock.now(),
      });
      if (!released) {
        return { released: false };
      }

      const applied = await ctx.vehicles.update(vehicle, versionBeforeUpdate);
      if (!applied) {
        throw new ConflictError('Conflito de concorrência ao liberar a reserva', {
          vehicleId: vehicle.id,
        });
      }

      await ctx.outbox.enqueue(
        this.events.build<VehicleReservationReleasedPayload & Record<string, unknown>>(
          VehicleEventType.RESERVATION_RELEASED,
          vehicle.id,
          {
            vehicleId: vehicle.id,
            reservationId,
            orderId: command.orderId,
            reason: command.reason,
          },
          { correlationId: command.correlationId, orderId: command.orderId },
        ),
      );

      return { released: true };
    });
  }
}
