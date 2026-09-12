import { CustomerEventType, DomainEvent } from '../../domain/events/domain-event';
import { Clock } from '../ports/clock';
import { IdGenerator } from '../ports/id-generator';

export class EventFactory {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  build<T extends Record<string, unknown>>(
    eventType: CustomerEventType,
    aggregateId: string,
    payload: T,
    correlationId: string,
  ): DomainEvent<T> {
    return {
      eventId: this.ids.generate(),
      eventType,
      eventVersion: 1,
      occurredAt: this.clock.now().toISOString(),
      aggregateId,
      aggregateType: 'customer',
      correlationId,
      payload,
    };
  }
}
