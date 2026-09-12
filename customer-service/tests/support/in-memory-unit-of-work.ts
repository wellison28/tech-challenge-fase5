import { TransactionalContext, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { Customer } from '../../src/domain/entities/customer';
import { DataAccessLog, DataAccessLogProps } from '../../src/domain/entities/data-access-log';
import { DomainEvent } from '../../src/domain/events/domain-event';
import {
  CustomerFilters,
  CustomerRepository,
  PageQuery,
  Paginated,
} from '../../src/domain/repositories/customer-repository';
import { DataAccessLogRepository } from '../../src/domain/repositories/data-access-log-repository';
import { OutboxRecord, OutboxRepository } from '../../src/domain/repositories/outbox-repository';
import { Cpf } from '../../src/domain/value-objects/cpf';
import { Email } from '../../src/domain/value-objects/email';

/**
 * Dublê do repositório.
 *
 * Guarda o CPF em claro de propósito — é um dublê de memória, e reproduzir o
 * índice cego aqui não acrescentaria nada ao que está sendo testado (as regras
 * de negócio). A cifra em si é testada separadamente, contra a implementação
 * real, em `tests/unit/crypto`.
 */
export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly rows = new Map<string, ReturnType<Customer['toSnapshot']>>();

  failNextUpdate = false;

  async create(customer: Customer): Promise<void> {
    this.rows.set(customer.id, customer.toSnapshot());
  }

  async update(customer: Customer, expectedVersion: number): Promise<boolean> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return false;
    }
    const current = this.rows.get(customer.id);
    if (!current || current.version !== expectedVersion) {
      return false;
    }
    this.rows.set(customer.id, customer.toSnapshot());
    return true;
  }

  async findById(id: string): Promise<Customer | null> {
    const snapshot = this.rows.get(id);
    return snapshot ? Customer.restore(snapshot) : null;
  }

  async findByCpf(cpf: Cpf): Promise<Customer | null> {
    for (const snapshot of this.rows.values()) {
      if (snapshot.cpf?.value === cpf.value) return Customer.restore(snapshot);
    }
    return null;
  }

  async findByEmail(email: Email): Promise<Customer | null> {
    for (const snapshot of this.rows.values()) {
      if (snapshot.email?.value === email.value) return Customer.restore(snapshot);
    }
    return null;
  }

  async list(filters: CustomerFilters, page: PageQuery): Promise<Paginated<Customer>> {
    let items = [...this.rows.values()].map((snapshot) => Customer.restore(snapshot));
    if (filters.status) items = items.filter((customer) => customer.status === filters.status);

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
}

export class InMemoryDataAccessLogRepository implements DataAccessLogRepository {
  readonly entries: DataAccessLogProps[] = [];

  async append(log: DataAccessLog): Promise<void> {
    this.entries.push(log.toJSON());
  }

  async listByCustomer(customerId: string, limit: number): Promise<DataAccessLogProps[]> {
    return this.entries.filter((entry) => entry.customerId === customerId).slice(0, limit);
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
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
    readonly customers = new InMemoryCustomerRepository(),
    readonly auditLog = new InMemoryDataAccessLogRepository(),
    readonly outbox = new InMemoryOutboxRepository(),
  ) {}

  async execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work({ customers: this.customers, auditLog: this.auditLog, outbox: this.outbox });
  }
}
