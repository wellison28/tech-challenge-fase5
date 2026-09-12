import type { Vehicle as VehicleRow } from '@prisma/client';
import {
  FuelType,
  Transmission,
  Vehicle,
  VehicleStatus,
} from '../../../domain/entities/vehicle';
import { LicensePlate } from '../../../domain/value-objects/license-plate';
import { Money } from '../../../domain/value-objects/money';
import { Vin } from '../../../domain/value-objects/vin';

/** Traduz a linha do banco para o agregado, e vice-versa. */
export const VehicleMapper = {
  toDomain(row: VehicleRow): Vehicle {
    return Vehicle.restore({
      id: row.id,
      vin: Vin.create(row.vin),
      licensePlate: row.licensePlate ? LicensePlate.create(row.licensePlate) : null,
      brand: row.brand,
      model: row.model,
      modelYear: row.modelYear,
      manufactureYear: row.manufactureYear,
      color: row.color,
      mileageKm: row.mileageKm,
      fuelType: row.fuelType as FuelType,
      transmission: row.transmission as Transmission,
      price: Money.fromCents(row.priceInCents),
      status: row.status as VehicleStatus,
      reservation:
        row.reservationId && row.reservationCustomerId && row.reservationOrderId && row.reservedAt && row.reservationExpiresAt
          ? {
              id: row.reservationId,
              customerId: row.reservationCustomerId,
              orderId: row.reservationOrderId,
              reservedAt: row.reservedAt,
              expiresAt: row.reservationExpiresAt,
            }
          : null,
      sale:
        row.saleOrderId && row.saleCustomerId && row.soldAt && row.soldPriceInCents !== null
          ? {
              orderId: row.saleOrderId,
              customerId: row.saleCustomerId,
              soldAt: row.soldAt,
              soldPrice: Money.fromCents(row.soldPriceInCents),
            }
          : null,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toPersistence(vehicle: Vehicle) {
    const snapshot = vehicle.toSnapshot();
    return {
      id: snapshot.id,
      vin: snapshot.vin.value,
      licensePlate: snapshot.licensePlate?.value ?? null,
      brand: snapshot.brand,
      model: snapshot.model,
      modelYear: snapshot.modelYear,
      manufactureYear: snapshot.manufactureYear,
      color: snapshot.color,
      mileageKm: snapshot.mileageKm,
      fuelType: snapshot.fuelType,
      transmission: snapshot.transmission,
      priceInCents: snapshot.price.cents,
      status: snapshot.status,
      version: snapshot.version,
      reservationId: snapshot.reservation?.id ?? null,
      reservationCustomerId: snapshot.reservation?.customerId ?? null,
      reservationOrderId: snapshot.reservation?.orderId ?? null,
      reservedAt: snapshot.reservation?.reservedAt ?? null,
      reservationExpiresAt: snapshot.reservation?.expiresAt ?? null,
      saleOrderId: snapshot.sale?.orderId ?? null,
      saleCustomerId: snapshot.sale?.customerId ?? null,
      soldAt: snapshot.sale?.soldAt ?? null,
      soldPriceInCents: snapshot.sale?.soldPrice.cents ?? null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  },
};
