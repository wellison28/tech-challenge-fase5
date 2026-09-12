import { CustomerRepository } from '../../domain/repositories/customer-repository';
import { DataAccessLogRepository } from '../../domain/repositories/data-access-log-repository';
import { OutboxRepository } from '../../domain/repositories/outbox-repository';

export interface TransactionalContext {
  customers: CustomerRepository;
  auditLog: DataAccessLogRepository;
  outbox: OutboxRepository;
}

/**
 * A trilha de auditoria participa da mesma transação da operação auditada.
 *
 * Se o registro de auditoria ficasse fora, uma falha entre a leitura do dado e
 * a gravação do log produziria acesso sem rastro — precisamente o cenário que
 * a auditoria existe para impedir.
 */
export interface UnitOfWork {
  execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}
