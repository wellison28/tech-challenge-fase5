import { FuelType, Transmission } from '../../domain/entities/vehicle';
import {
  ConflictError,
  DuplicateResourceError,
  NotFoundError,
} from '../../domain/errors/domain-error';
import { VehicleCatalogPayload, VehicleEventType } from '../../domain/events/domain-event';
import { LicensePlate } from '../../domain/value-objects/license-plate';
import { VehicleDTO, toVehicleDTO } from '../dto/vehicle-dto';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface UpdateVehicleCommand {
  vehicleId: string;
  licensePlate?: string | null;
  brand?: string;
  model?: string;
  modelYear?: number;
  manufactureYear?: number;
  color?: string;
  mileageKm?: number;
  fuelType?: FuelType;
  transmission?: Transmission;
  priceInCents?: number;
  /** Versão que o cliente leu; habilita controle de concorrência otimista via If-Match. */
  expectedVersion?: number;
  correlationId: string;
}

export class UpdateVehicleUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
  ) {}

  async execute(command: UpdateVehicleCommand): Promise<VehicleDTO> {
    return this.uow.execute(async (ctx) => {
      const vehicle = await ctx.vehicles.findById(command.vehicleId);
      if (!vehicle) {
        throw new NotFoundError('Veículo', command.vehicleId);
      }
      if (command.expectedVersion !== undefined && vehicle.version !== command.expectedVersion) {
        throw new ConflictError('O veículo foi alterado por outra operação; recarregue os dados', {
          vehicleId: vehicle.id,
          currentVersion: vehicle.version,
          expectedVersion: command.expectedVersion,
        });
      }

      if (command.licensePlate) {
        const plate = LicensePlate.create(command.licensePlate);
        const owner = await ctx.vehicles.findByLicensePlate(plate.value);
        if (owner && owner.id !== vehicle.id) {
          throw new DuplicateResourceError('placa', plate.value);
        }
      }

      const versionBeforeUpdate = vehicle.version;
      vehicle.update({ ...command, now: this.clock.now() });

      const applied = await ctx.vehicles.update(vehicle, versionBeforeUpdate);
      if (!applied) {
        throw new ConflictError('Conflito de concorrência ao atualizar o veículo', {
          vehicleId: vehicle.id,
        });
      }

      await ctx.outbox.enqueue(
        this.events.build<VehicleCatalogPayload & Record<string, unknown>>(
          VehicleEventType.UPDATED,
          vehicle.id,
          {
            vehicleId: vehicle.id,
            vin: vehicle.vin.value,
            brand: vehicle.brand,
            model: vehicle.model,
            modelYear: vehicle.modelYear,
            color: vehicle.color,
            priceInCents: vehicle.price.cents,
          },
          { correlationId: command.correlationId },
        ),
      );

      return toVehicleDTO(vehicle);
    });
  }
}
