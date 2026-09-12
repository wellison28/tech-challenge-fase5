import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { VehicleEventType, VehicleReservedPayload } from '../../domain/events/domain-event';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { IdGenerator } from '../ports/id-generator';
import { UnitOfWork } from '../ports/unit-of-work';

export interface ReserveVehicleCommand {
  vehicleId: string;
  customerId: string;
  /** Pedido da SAGA. Torna o passo idempotente e liga a reserva ao processo. */
  orderId: string;
  correlationId: string;
}

export interface ReserveVehicleResult {
  reservationId: string;
  vehicleId: string;
  orderId: string;
  priceInCents: number;
  expiresAt: string;
  /** `true` quando a chamada apenas reconheceu uma reserva que já existia. */
  alreadyReserved: boolean;
}

/**
 * Passo 1 da SAGA de compra.
 *
 * É aqui que se resolve o cenário descrito no enunciado: "entre o processo do
 * cliente selecionar o veículo e realizar a reserva, outro cliente reserva o
 * veículo antes". A garantia vem de duas camadas:
 *   1. a invariante do agregado (`Vehicle.reserve`), que recusa reserva sobre
 *      reserva ativa de outro pedido;
 *   2. a trava otimista no UPDATE, que faz a segunda transação concorrente
 *      falhar mesmo que ambas tenham lido o veículo como disponível.
 * O perdedor da disputa recebe 409 e a SAGA compensa/encerra sem efeito colateral.
 */
export class ReserveVehicleUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly reservationTtlMinutes: number,
  ) {}

  async execute(command: ReserveVehicleCommand): Promise<ReserveVehicleResult> {
    return this.uow.execute(async (ctx) => {
      const vehicle = await ctx.vehicles.findById(command.vehicleId);
      if (!vehicle) {
        throw new NotFoundError('Veículo', command.vehicleId);
      }

      const now = this.clock.now();
      const activeReservation = vehicle.reservation;
      const isRetryOfSameOrder =
        activeReservation?.orderId === command.orderId && !vehicle.hasExpiredReservation(now);

      if (isRetryOfSameOrder && activeReservation) {
        return {
          reservationId: activeReservation.id,
          vehicleId: vehicle.id,
          orderId: command.orderId,
          priceInCents: vehicle.price.cents,
          expiresAt: activeReservation.expiresAt.toISOString(),
          alreadyReserved: true,
        };
      }

      // A versão da trava otimista é a que foi LIDA do banco: capturada antes de
      // qualquer mutação em memória, que já incrementa o contador do agregado.
      const versionBeforeUpdate = vehicle.version;

      // Reserva vencida ainda gravada: devolve ao estoque antes de reservar de novo.
      if (vehicle.hasExpiredReservation(now)) {
        vehicle.releaseReservation({ now });
      }

      const reservation = vehicle.reserve({
        reservationId: this.ids.generate(),
        customerId: command.customerId,
        orderId: command.orderId,
        ttlMinutes: this.reservationTtlMinutes,
        now,
      });

      const applied = await ctx.vehicles.update(vehicle, versionBeforeUpdate);
      if (!applied) {
        // Outra transação reservou primeiro entre o SELECT e o UPDATE.
        throw new ConflictError('Veículo reservado por outro cliente durante a operação', {
          vehicleId: vehicle.id,
        });
      }

      await ctx.outbox.enqueue(
        this.events.build<VehicleReservedPayload & Record<string, unknown>>(
          VehicleEventType.RESERVED,
          vehicle.id,
          {
            vehicleId: vehicle.id,
            reservationId: reservation.id,
            customerId: reservation.customerId,
            orderId: reservation.orderId,
            priceInCents: vehicle.price.cents,
            expiresAt: reservation.expiresAt.toISOString(),
          },
          { correlationId: command.correlationId, orderId: command.orderId },
        ),
      );

      return {
        reservationId: reservation.id,
        vehicleId: vehicle.id,
        orderId: command.orderId,
        priceInCents: vehicle.price.cents,
        expiresAt: reservation.expiresAt.toISOString(),
        alreadyReserved: false,
      };
    });
  }
}
