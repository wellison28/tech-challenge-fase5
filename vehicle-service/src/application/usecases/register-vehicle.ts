import { FuelType, Transmission, Vehicle } from '../../domain/entities/vehicle';
import { DuplicateResourceError } from '../../domain/errors/domain-error';
import { VehicleCatalogPayload, VehicleEventType } from '../../domain/events/domain-event';
import { LicensePlate } from '../../domain/value-objects/license-plate';
import { Vin } from '../../domain/value-objects/vin';
import { VehicleDTO, toVehicleDTO } from '../dto/vehicle-dto';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { IdGenerator } from '../ports/id-generator';
import { UnitOfWork } from '../ports/unit-of-work';

export interface RegisterVehicleCommand {
  vin: string;
  licensePlate?: string | null;
  brand: string;
  model: string;
  modelYear: number;
  manufactureYear: number;
  color: string;
  mileageKm: number;
  fuelType: FuelType;
  transmission: Transmission;
  priceInCents: number;
  correlationId: string;
}

export class RegisterVehicleUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
  ) {}

  async execute(command: RegisterVehicleCommand): Promise<VehicleDTO> {
    // Normaliza antes de consultar para que a checagem de duplicidade use a
    // mesma forma canônica que será gravada.
    const vin = Vin.create(command.vin);
    const plate = command.licensePlate ? LicensePlate.create(command.licensePlate) : null;

    const vehicle = Vehicle.create({
      id: this.ids.generate(),
      vin: vin.value,
      licensePlate: plate?.value ?? null,
      brand: command.brand,
      model: command.model,
      modelYear: command.modelYear,
      manufactureYear: command.manufactureYear,
      color: command.color,
      mileageKm: command.mileageKm,
      fuelType: command.fuelType,
      transmission: command.transmission,
      priceInCents: command.priceInCents,
      now: this.clock.now(),
    });

    return this.uow.execute(async (ctx) => {
      if (await ctx.vehicles.findByVin(vin.value)) {
        throw new DuplicateResourceError('chassi', vin.value);
      }
      if (plate && (await ctx.vehicles.findByLicensePlate(plate.value))) {
        throw new DuplicateResourceError('placa', plate.value);
      }

      await ctx.vehicles.create(vehicle);
      await ctx.outbox.enqueue(
        this.events.build<VehicleCatalogPayload & Record<string, unknown>>(
          VehicleEventType.REGISTERED,
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
