import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainEvent } from '../../../domain/events/domain-event';
import { OutboxRecord, OutboxRepository } from '../../../domain/repositories/outbox-repository';

type Client = PrismaClient | Prisma.TransactionClient;

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly client: Client) {}

  async enqueue(event: DomainEvent): Promise<void> {
    await this.client.outboxEvent.create({
      data: {
        id: event.eventId,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        payload: event as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async fetchUnpublished(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.client.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      event: row.payload as unknown as DomainEvent,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt,
      attempts: row.attempts,
    }));
  }

  async markPublished(ids: string[], publishedAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.client.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.client.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 2000) },
    });
  }
}
