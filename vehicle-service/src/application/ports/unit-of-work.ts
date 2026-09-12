import { OutboxRepository } from '../../domain/repositories/outbox-repository';
import { VehicleRepository } from '../../domain/repositories/vehicle-repository';

export interface TransactionalContext {
  vehicles: VehicleRepository;
  outbox: OutboxRepository;
}

/**
 * Delimita a fronteira transacional dos casos de uso sem vazar o ORM para a
 * camada de aplicação. A implementação concreta (Prisma) vive em infrastructure.
 */
export interface UnitOfWork {
  execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}
