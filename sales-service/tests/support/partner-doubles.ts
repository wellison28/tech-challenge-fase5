import {
  BillingProfile,
  CustomerDirectoryPort,
  EligibilityCheck,
} from '../../src/application/ports/customer-directory';
import { SagaCallbackPort } from '../../src/application/ports/saga-callback';
import {
  VehicleCatalogPort,
  VehicleReservation,
} from '../../src/application/ports/vehicle-catalog';
import { SagaStepError } from '../../src/domain/errors/domain-error';

/**
 * Dublê do vehicle-service.
 *
 * Reproduz os dois comportamentos que importam para a SAGA: a reserva
 * idempotente por pedido e o conflito quando outro cliente chegou antes.
 */
export class FakeVehicleCatalog implements VehicleCatalogPort {
  readonly calls: string[] = [];
  private readonly reservationsByOrder = new Map<string, VehicleReservation>();
  private readonly reservedVehicles = new Map<string, string>();
  readonly soldVehicles = new Set<string>();
  private readonly soldByOrder = new Map<string, string>();
  readonly releasedOrders: string[] = [];

  priceInCents = 12_990_000;
  reservationTtlMinutes = 30;
  /** Liga a falha transitória: as duas primeiras chamadas a `reserve` falham. */
  transientFailuresOnReserve = 0;
  failReleaseOnce = false;
  failConfirmSale = false;

  async reserve(params: {
    vehicleId: string;
    customerId: string;
    orderId: string;
  }): Promise<VehicleReservation> {
    this.calls.push('reserve');

    if (this.transientFailuresOnReserve > 0) {
      this.transientFailuresOnReserve -= 1;
      throw new SagaStepError('RESERVE_VEHICLE', 'serviço indisponível', true);
    }

    const existing = this.reservationsByOrder.get(params.orderId);
    if (existing) {
      return { ...existing, alreadyReserved: true };
    }

    const holder = this.reservedVehicles.get(params.vehicleId);
    if (holder && holder !== params.orderId) {
      throw new SagaStepError('RESERVE_VEHICLE', 'veículo já reservado (409)', false);
    }
    if (this.soldVehicles.has(params.vehicleId)) {
      throw new SagaStepError('RESERVE_VEHICLE', 'veículo já vendido (409)', false);
    }

    const reservation: VehicleReservation = {
      reservationId: `res-${params.orderId}`,
      vehicleId: params.vehicleId,
      priceInCents: this.priceInCents,
      expiresAt: new Date(Date.now() + this.reservationTtlMinutes * 60_000).toISOString(),
      alreadyReserved: false,
    };

    this.reservationsByOrder.set(params.orderId, reservation);
    this.reservedVehicles.set(params.vehicleId, params.orderId);
    return reservation;
  }

  async releaseReservation(params: { vehicleId: string; orderId: string }): Promise<void> {
    this.calls.push('release');
    if (this.failReleaseOnce) {
      this.failReleaseOnce = false;
      throw new SagaStepError('COMPENSATE_RELEASE_VEHICLE', 'falha ao liberar', true);
    }
    if (this.reservedVehicles.get(params.vehicleId) === params.orderId) {
      this.reservedVehicles.delete(params.vehicleId);
    }
    this.reservationsByOrder.delete(params.orderId);
    this.releasedOrders.push(params.orderId);
  }

  async confirmSale(params: { vehicleId: string; orderId: string }): Promise<void> {
    this.calls.push('confirmSale');
    if (this.failConfirmSale) {
      throw new SagaStepError('CONFIRM_SALE', 'reserva expirou (409)', false);
    }
    // Idempotente, como o vehicle-service real: reconfirmar a mesma venda é aceito.
    if (this.soldByOrder.get(params.vehicleId) === params.orderId) {
      return;
    }
    if (this.reservedVehicles.get(params.vehicleId) !== params.orderId) {
      throw new SagaStepError('CONFIRM_SALE', 'sem reserva ativa deste pedido (409)', false);
    }
    this.soldVehicles.add(params.vehicleId);
    this.soldByOrder.set(params.vehicleId, params.orderId);
    this.reservedVehicles.delete(params.vehicleId);
  }

  /** Simula outro comprador levando o veículo primeiro. */
  reserveForAnotherOrder(vehicleId: string, orderId: string): void {
    this.reservedVehicles.set(vehicleId, orderId);
  }

  isReserved(vehicleId: string): boolean {
    return this.reservedVehicles.has(vehicleId);
  }
}

export class FakeCustomerDirectory implements CustomerDirectoryPort {
  eligible = true;
  reasons: string[] = [];
  billingProfileCalls = 0;

  async checkEligibility(params: { customerId: string }): Promise<EligibilityCheck> {
    return {
      customerId: params.customerId,
      eligible: this.eligible,
      reasons: this.eligible ? [] : this.reasons,
    };
  }

  async getBillingProfile(params: { customerId: string }): Promise<BillingProfile> {
    this.billingProfileCalls += 1;
    return {
      customerId: params.customerId,
      fullName: 'Maria Aparecida da Silva',
      cpf: '52998224725',
      email: 'maria.silva@exemplo.com.br',
      phone: '11987654321',
    };
  }
}

export class RecordingSagaCallback implements SagaCallbackPort {
  readonly succeeded: Array<{ taskToken: string }> = [];
  readonly failed: Array<{ taskToken: string; error: string; cause: string }> = [];

  async succeed(params: { taskToken: string }): Promise<void> {
    this.succeeded.push({ taskToken: params.taskToken });
  }

  async fail(params: { taskToken: string; error: string; cause: string }): Promise<void> {
    this.failed.push(params);
  }
}

export const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
