import { DomainEvent } from '../events/domain-event';

export interface OutboxRecord {
  id: string;
  event: DomainEvent;
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
}

/**
 * Transactional Outbox.
 *
 * Gravar o estado no banco e publicar o evento no barramento são duas escritas
 * em sistemas diferentes: sem outbox, uma falha entre elas deixa o estoque
 * alterado e a SAGA sem notificação (ou o contrário). Aqui o evento é gravado
 * na MESMA transação da mudança de estado e um processo separado o entrega ao
 * EventBridge, garantindo entrega ao-menos-uma-vez.
 */
export interface OutboxRepository {
  enqueue(event: DomainEvent): Promise<void>;
  fetchUnpublished(limit: number): Promise<OutboxRecord[]>;
  markPublished(ids: string[], publishedAt: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}
