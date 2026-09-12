/**
 * Porta para o vehicle-service.
 *
 * Cada método corresponde a um passo (ou compensação) da SAGA. A interface
 * pertence a esta camada, e não ao serviço remoto: é o sales-service quem
 * define o que precisa, e o adaptador HTTP se encarrega de traduzir.
 */
export interface VehicleReservation {
  reservationId: string;
  vehicleId: string;
  priceInCents: number;
  expiresAt: string;
  alreadyReserved: boolean;
}

export interface VehicleCatalogPort {
  /** Passo 1. Idempotente por `orderId`. */
  reserve(params: {
    vehicleId: string;
    customerId: string;
    orderId: string;
    correlationId: string;
  }): Promise<VehicleReservation>;

  /** Compensação do passo 1. Idempotente. */
  releaseReservation(params: {
    vehicleId: string;
    orderId: string;
    reservationId: string | null;
    reason: 'SAGA_COMPENSATION' | 'CUSTOMER_GAVE_UP' | 'PAYMENT_FAILED';
    correlationId: string;
  }): Promise<void>;

  /** Passo 5: baixa no estoque. Idempotente por `orderId`. */
  confirmSale(params: {
    vehicleId: string;
    orderId: string;
    customerId: string;
    correlationId: string;
  }): Promise<void>;
}
