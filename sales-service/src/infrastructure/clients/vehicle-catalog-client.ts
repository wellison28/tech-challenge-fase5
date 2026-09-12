import {
  VehicleCatalogPort,
  VehicleReservation,
} from '../../application/ports/vehicle-catalog';
import { HttpClient } from './http-client';

/** Adaptador HTTP do vehicle-service. */
export class VehicleCatalogClient implements VehicleCatalogPort {
  constructor(private readonly http: HttpClient) {}

  async reserve(params: {
    vehicleId: string;
    customerId: string;
    orderId: string;
    correlationId: string;
  }): Promise<VehicleReservation> {
    return this.http.send<VehicleReservation>({
      method: 'POST',
      path: `/vehicles/${params.vehicleId}/reservations`,
      body: { customerId: params.customerId, orderId: params.orderId },
      correlationId: params.correlationId,
      step: 'RESERVE_VEHICLE',
    });
  }

  async releaseReservation(params: {
    vehicleId: string;
    orderId: string;
    reservationId: string | null;
    reason: 'SAGA_COMPENSATION' | 'CUSTOMER_GAVE_UP' | 'PAYMENT_FAILED';
    correlationId: string;
  }): Promise<void> {
    await this.http.send<{ released: boolean }>({
      method: 'POST',
      path: `/vehicles/${params.vehicleId}/reservations/release`,
      body: {
        orderId: params.orderId,
        ...(params.reservationId ? { reservationId: params.reservationId } : {}),
        reason: params.reason,
      },
      correlationId: params.correlationId,
      step: 'COMPENSATE_RELEASE_VEHICLE',
    });
  }

  async confirmSale(params: {
    vehicleId: string;
    orderId: string;
    customerId: string;
    correlationId: string;
  }): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: `/vehicles/${params.vehicleId}/sale`,
      body: { orderId: params.orderId, customerId: params.customerId },
      correlationId: params.correlationId,
      step: 'CONFIRM_SALE',
    });
  }
}
