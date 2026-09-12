import {
  VehicleEventType,
  VehicleReservationReleasedPayload,
} from '../../domain/events/domain-event';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface ExpireReservationsResult {
  scanned: number;
  released: number;
  skippedByConcurrency: number;
}

/**
 * Rede de segurança do estoque, executada por um EventBridge Scheduler
 * (Lambda a cada minuto).
 *
 * A SAGA já libera a reserva quando o pagamento falha ou o cliente desiste, mas
 * nenhum orquestrador é infalível: uma execução pode morrer entre a reserva e a
 * compensação. Sem este processo, uma unidade ficaria presa fora do estoque
 * indefinidamente. Ele torna o TTL da reserva a garantia final de liveness —
 * o veículo sempre volta à vitrine.
 */
export class ExpireReservationsUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly batchSize = 50,
  ) {}

  async execute(): Promise<ExpireReservationsResult> {
    const now = this.clock.now();
    const candidates = await this.uow.execute((ctx) =>
      ctx.vehicles.findExpiredReservations(now, this.batchSize),
    );

    let released = 0;
    let skippedByConcurrency = 0;

    // Uma transação por veículo: um conflito isolado não derruba o lote inteiro.
    for (const candidate of candidates) {
      const outcome = await this.uow.execute(async (ctx) => {
        const vehicle = await ctx.vehicles.findById(candidate.id);
        if (!vehicle?.hasExpiredReservation(now)) {
          return 'skipped';
        }

        const reservation = vehicle.reservation!;
        const versionBeforeUpdate = vehicle.version;
        vehicle.releaseReservation({ reservationId: reservation.id, now });

        if (!(await ctx.vehicles.update(vehicle, versionBeforeUpdate))) {
          return 'conflict';
        }

        await ctx.outbox.enqueue(
          this.events.build<VehicleReservationReleasedPayload & Record<string, unknown>>(
            VehicleEventType.RESERVATION_EXPIRED,
            vehicle.id,
            {
              vehicleId: vehicle.id,
              reservationId: reservation.id,
              orderId: reservation.orderId,
              reason: 'RESERVATION_EXPIRED',
            },
            { correlationId: `expire-${reservation.id}`, orderId: reservation.orderId },
          ),
        );
        return 'released';
      });

      if (outcome === 'released') released += 1;
      if (outcome === 'conflict') skippedByConcurrency += 1;
    }

    return { scanned: candidates.length, released, skippedByConcurrency };
  }
}
