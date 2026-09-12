import { TransactionalContext, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { Order, OrderStatus, TERMINAL_STATUSES } from '../../src/domain/entities/order';
import { DomainEvent } from '../../src/domain/events/domain-event';
import {
  OrderFilters,
  OrderRepository,
  PageQuery,
  Paginated,
} from '../../src/domain/repositories/order-repository';
import { OutboxRecord, OutboxRepository } from '../../src/domain/repositories/outbox-repository';

export class InMemoryOrderRepository implements OrderRepository {
  private readonly rows = new Map<string, ReturnType<Order['toSnapshot']>>();

  failNextUpdate = false;

  async create(order: Order): Promise<void> {
    this.rows.set(order.id, order.toSnapshot());
  }

  async update(order: Order, expectedVersion: number): Promise<boolean> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return false;
    }
    const current = this.rows.get(order.id);
    if (!current || current.version !== expectedVersion) {
      return false;
    }
    this.rows.set(order.id, order.toSnapshot());
    return true;
  }

  async findById(id: string): Promise<Order | null> {
    const snapshot = this.rows.get(id);
    return snapshot ? Order.restore(snapshot) : null;
  }

  async findByPaymentChargeId(chargeId: string): Promise<Order | null> {
    for (const snapshot of this.rows.values()) {
      if (snapshot.paymentChargeId === chargeId) return Order.restore(snapshot);
    }
    return null;
  }

  async findActiveByCustomerAndVehicle(
    customerId: string,
    vehicleId: string,
  ): Promise<Order | null> {
    for (const snapshot of this.rows.values()) {
      if (
        snapshot.customerId === customerId &&
        snapshot.vehicleId === vehicleId &&
        !TERMINAL_STATUSES.includes(snapshot.status)
      ) {
        return Order.restore(snapshot);
      }
    }
    return null;
  }

  async list(filters: OrderFilters, page: PageQuery): Promise<Paginated<Order>> {
    let items = [...this.rows.values()].map((snapshot) => Order.restore(snapshot));

    if (filters.customerId) items = items.filter((o) => o.customerId === filters.customerId);
    if (filters.vehicleId) items = items.filter((o) => o.vehicleId === filters.vehicleId);
    if (filters.status) items = items.filter((o) => o.status === filters.status);

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

  async findExpiredAwaitingPayment(now: Date, limit: number): Promise<Order[]> {
    return [...this.rows.values()]
      .map((snapshot) => Order.restore(snapshot))
      .filter(
        (order) =>
          order.status === OrderStatus.AWAITING_PAYMENT && order.isPaymentWindowExpired(now),
      )
      .slice(0, limit);
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  readonly records: OutboxRecord[] = [];

  async enqueue(event: DomainEvent): Promise<void> {
    this.records.push({
      id: event.eventId,
      event,
      createdAt: new Date(),
      publishedAt: null,
      attempts: 0,
    });
  }

  async fetchUnpublished(limit: number): Promise<OutboxRecord[]> {
    return this.records.filter((record) => record.publishedAt === null).slice(0, limit);
  }

  async markPublished(ids: string[], publishedAt: Date): Promise<void> {
    for (const record of this.records) {
      if (ids.includes(record.id)) record.publishedAt = publishedAt;
    }
  }

  async markFailed(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (record) record.attempts += 1;
  }

  eventTypes(): string[] {
    return this.records.map((record) => record.event.eventType);
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(
    readonly orders = new InMemoryOrderRepository(),
    readonly outbox = new InMemoryOutboxRepository(),
  ) {}

  async execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work({ orders: this.orders, outbox: this.outbox });
  }
}
