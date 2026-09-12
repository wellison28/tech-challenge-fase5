import { OrderRepository } from '../../domain/repositories/order-repository';
import { OutboxRepository } from '../../domain/repositories/outbox-repository';

export interface TransactionalContext {
  orders: OrderRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}
