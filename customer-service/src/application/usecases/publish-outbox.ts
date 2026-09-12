import { EventPublisher } from '../ports/event-publisher';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxResult {
  fetched: number;
  published: number;
  failed: number;
}

/**
 * Despachante do outbox: lê os eventos ainda não entregues e os publica no
 * EventBridge. Entrega ao-menos-uma-vez — por isso todo consumidor deduplica
 * por `eventId`. Roda como Lambda agendada e também logo após a transação,
 * para manter a latência baixa no caminho feliz.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize = 25,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    const records = await this.uow.execute((ctx) => ctx.outbox.fetchUnpublished(this.batchSize));
    if (records.length === 0) {
      return { fetched: 0, published: 0, failed: 0 };
    }

    let published = 0;
    let failed = 0;

    try {
      await this.publisher.publish(records.map((record) => record.event));
      await this.uow.execute((ctx) =>
        ctx.outbox.markPublished(
          records.map((record) => record.id),
          this.clock.now(),
        ),
      );
      published = records.length;
    } catch (error) {
      failed = records.length;
      const message = error instanceof Error ? error.message : String(error);
      await this.uow.execute(async (ctx) => {
        for (const record of records) {
          await ctx.outbox.markFailed(record.id, message);
        }
      });
    }

    return { fetched: records.length, published, failed };
  }
}
