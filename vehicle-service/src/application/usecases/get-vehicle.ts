import { NotFoundError } from '../../domain/errors/domain-error';
import { VehicleDTO, toVehicleDTO } from '../dto/vehicle-dto';
import { UnitOfWork } from '../ports/unit-of-work';

export class GetVehicleUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(vehicleId: string): Promise<VehicleDTO> {
    const vehicle = await this.uow.execute((ctx) => ctx.vehicles.findById(vehicleId));
    if (!vehicle) {
      throw new NotFoundError('Veículo', vehicleId);
    }
    return toVehicleDTO(vehicle);
  }
}
