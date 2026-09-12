import { Vehicle } from '../../domain/entities/vehicle';

/** Representação de saída do veículo. Preço exposto em centavos e em reais. */
export interface VehicleDTO {
  id: string;
  vin: string;
  licensePlate: string | null;
  brand: string;
  model: string;
  modelYear: number;
  manufactureYear: number;
  color: string;
  mileageKm: number;
  fuelType: string;
  transmission: string;
  priceInCents: number;
  price: number;
  priceFormatted: string;
  status: string;
  reservation: {
    id: string;
    orderId: string;
    expiresAt: string;
  } | null;
  sale: {
    orderId: string;
    soldAt: string;
    soldPriceInCents: number;
  } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * `customerId` é dado pessoal e não pertence ao catálogo público: a reserva é
 * exposta sem o titular, e somente o serviço de vendas (dono do pedido) sabe
 * quem é o comprador. Minimização de dados na prática.
 */
export function toVehicleDTO(vehicle: Vehicle): VehicleDTO {
  return {
    id: vehicle.id,
    vin: vehicle.vin.value,
    licensePlate: vehicle.licensePlate?.value ?? null,
    brand: vehicle.brand,
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    manufactureYear: vehicle.manufactureYear,
    color: vehicle.color,
    mileageKm: vehicle.mileageKm,
    fuelType: vehicle.fuelType,
    transmission: vehicle.transmission,
    priceInCents: vehicle.price.cents,
    price: vehicle.price.toDecimal(),
    priceFormatted: vehicle.price.format(),
    status: vehicle.status,
    reservation: vehicle.reservation
      ? {
          id: vehicle.reservation.id,
          orderId: vehicle.reservation.orderId,
          expiresAt: vehicle.reservation.expiresAt.toISOString(),
        }
      : null,
    sale: vehicle.sale
      ? {
          orderId: vehicle.sale.orderId,
          soldAt: vehicle.sale.soldAt.toISOString(),
          soldPriceInCents: vehicle.sale.soldPrice.cents,
        }
      : null,
    version: vehicle.version,
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}
