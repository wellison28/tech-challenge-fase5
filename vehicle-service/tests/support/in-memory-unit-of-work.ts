import { TransactionalContext, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { Vehicle, VehicleStatus } from '../../src/domain/entities/vehicle';
import { DomainEvent } from '../../src/domain/events/domain-event';
import { OutboxRecord, OutboxRepository } from '../../src/domain/repositories/outbox-repository';
import {
  PageQuery,
  Paginated,
  VehicleFilters,
  VehicleRepository,
} from '../../src/domain/repositories/vehicle-repository';

/**
 * Dublê em memória do repositório, incluindo a semântica de trava otimista.
 *
 * Reproduzir o comportamento de versão aqui é o que permite testar disputa de
 * estoque (dois pedidos no mesmo veículo) sem subir banco: o segundo `update`
 * com a versão antiga falha exatamente como falharia no Postgres.
 */
export class InMemoryVehicleRepository implements VehicleRepository {
  private readonly rows = new Map<string, { snapshot: ReturnType<Vehicle['toSnapshot']> }>();

  /** Quando ligado, o próximo `update` falha como se outra transação tivesse escrito antes. */
  failNextUpdate = false;

  async create(vehicle: Vehicle): Promise<void> {
    this.rows.set(vehicle.id, { snapshot: vehicle.toSnapshot() });
  }

  async update(vehicle: Vehicle, expectedVersion: number): Promise<boolean> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return false;
    }
    const row = this.rows.get(vehicle.id);
    if (!row || row.snapshot.version !== expectedVersion) {
      return false;
    }
    this.rows.set(vehicle.id, { snapshot: vehicle.toSnapshot() });
    return true;
  }

  async findById(id: string): Promise<Vehicle | null> {
    const row = this.rows.get(id);
    return row ? Vehicle.restore(row.snapshot) : null;
  }

  async findByVin(vin: string): Promise<Vehicle | null> {
    return this.findBy((snapshot) => snapshot.vin.value === vin);
  }

  async findByLicensePlate(licensePlate: string): Promise<Vehicle | null> {
    return this.findBy((snapshot) => snapshot.licensePlate?.value === licensePlate);
  }

  async findByOrderId(orderId: string): Promise<Vehicle | null> {
    return this.findBy(
      (snapshot) =>
        snapshot.reservation?.orderId === orderId || snapshot.sale?.orderId === orderId,
    );
  }

  async list(filters: VehicleFilters, page: PageQuery): Promise<Paginated<Vehicle>> {
    let items = [...this.rows.values()].map((row) => Vehicle.restore(row.snapshot));

    if (filters.status) items = items.filter((v) => v.status === filters.status);
    if (filters.brand) {
      items = items.filter((v) => v.brand.toLowerCase().includes(filters.brand!.toLowerCase()));
    }
    if (filters.minPriceInCents !== undefined) {
      items = items.filter((v) => v.price.cents >= filters.minPriceInCents!);
    }
    if (filters.maxPriceInCents !== undefined) {
      items = items.filter((v) => v.price.cents <= filters.maxPriceInCents!);
    }

    const direction = page.sortDirection === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const left = page.sortBy === 'price' ? a.price.cents : a.modelYear;
      const right = page.sortBy === 'price' ? b.price.cents : b.modelYear;
      return left === right ? a.id.localeCompare(b.id) : (left - right) * direction;
    });

    const total = items.length;
    const start = (page.page - 1) * page.pageSize;
    return {
      items: items.slice(start, start + page.pageSize),
      total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: Math.max(1, Math.ceil(total / page.pageSize)),
    };
  }

  async findExpiredReservations(now: Date, limit: number): Promise<Vehicle[]> {
    return [...this.rows.values()]
      .map((row) => Vehicle.restore(row.snapshot))
      .filter(
        (vehicle) =>
          vehicle.status === VehicleStatus.RESERVED && vehicle.hasExpiredReservation(now),
      )
      .slice(0, limit);
  }

  private async findBy(
    predicate: (snapshot: ReturnType<Vehicle['toSnapshot']>) => boolean,
  ): Promise<Vehicle | null> {
    for (const row of this.rows.values()) {
      if (predicate(row.snapshot)) return Vehicle.restore(row.snapshot);
    }
    return null;
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  readonly records: OutboxRecord[] = [];

  async enqueue(event: DomainEvent): Promise<void> {
    this.records.push({ id: event.eventId, event, createdAt: new Date(), publishedAt: null, attempts: 0 });
  }

  async fetchUnpublished(limit: number): Promise<OutboxRecord[]> {
    return this.records.filter((record) => record.publishedAt === null).slice(0, limit);
  }

  async markPublished(ids: string[], publishedAt: Date): Promise<void> {
    for (const record of this.records) {
      if (ids.includes(record.id)) record.publishedAt = publishedAt;
    }
  }

  async markFailed(id: string, _error: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (record) record.attempts += 1;
  }

  eventTypes(): string[] {
    return this.records.map((record) => record.event.eventType);
  }
}

/** Executa o trabalho direto, sem transação — suficiente para os testes de unidade. */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(
    readonly vehicles = new InMemoryVehicleRepository(),
    readonly outbox = new InMemoryOutboxRepository(),
  ) {}

  async execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work({ vehicles: this.vehicles, outbox: this.outbox });
  }
}
