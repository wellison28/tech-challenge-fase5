/**
 * Envelope único de todos os eventos de domínio publicados pelo serviço.
 *
 * O contrato é versionado (`eventVersion`) porque consumidores evoluem em ritmo
 * próprio: um serviço só é autônomo se puder continuar lendo a versão antiga do
 * evento enquanto migra para a nova.
 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  /** Identificador único do evento — chave de deduplicação no consumidor. */
  readonly eventId: string;
  /** Nome no formato `<contexto>.<fato no passado>`, ex.: `vehicle.reserved`. */
  readonly eventType: VehicleEventType;
  readonly eventVersion: number;
  readonly occurredAt: string;
  /** Agregado que originou o fato. */
  readonly aggregateId: string;
  readonly aggregateType: 'vehicle';
  /** Propagado ponta a ponta para rastrear a SAGA inteira nos logs e no X-Ray. */
  readonly correlationId: string;
  /** Pedido da SAGA, quando o fato nasce de um passo do processo de compra. */
  readonly orderId?: string;
  readonly payload: TPayload;
}

export const VehicleEventType = {
  REGISTERED: 'vehicle.registered',
  UPDATED: 'vehicle.updated',
  RESERVED: 'vehicle.reserved',
  RESERVATION_RELEASED: 'vehicle.reservation_released',
  RESERVATION_EXPIRED: 'vehicle.reservation_expired',
  SOLD: 'vehicle.sold',
} as const;
export type VehicleEventType = (typeof VehicleEventType)[keyof typeof VehicleEventType];

export interface VehicleReservedPayload {
  vehicleId: string;
  reservationId: string;
  customerId: string;
  orderId: string;
  priceInCents: number;
  expiresAt: string;
}

export interface VehicleReservationReleasedPayload {
  vehicleId: string;
  reservationId: string;
  orderId: string;
  reason: 'SAGA_COMPENSATION' | 'CUSTOMER_GAVE_UP' | 'RESERVATION_EXPIRED' | 'PAYMENT_FAILED';
}

export interface VehicleSoldPayload {
  vehicleId: string;
  orderId: string;
  customerId: string;
  soldPriceInCents: number;
  soldAt: string;
}

export interface VehicleCatalogPayload {
  vehicleId: string;
  vin: string;
  brand: string;
  model: string;
  modelYear: number;
  color: string;
  priceInCents: number;
}
