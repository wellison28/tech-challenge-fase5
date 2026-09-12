import { DomainEvent, VehicleEventType } from '../../domain/events/domain-event';
import { Clock } from '../ports/clock';
import { IdGenerator } from '../ports/id-generator';

export interface EventContext {
  correlationId: string;
  orderId?: string;
}

export class EventFactory {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  build<T extends Record<string, unknown>>(
    eventType: VehicleEventType,
    aggregateId: string,
    payload: T,
    context: EventContext,
  ): DomainEvent<T> {
    return {
      eventId: this.ids.generate(),
      eventType,
      eventVersion: 1,
      occurredAt: this.clock.now().toISOString(),
      aggregateId,
      aggregateType: 'vehicle',
      correlationId: context.correlationId,
      ...(context.orderId ? { orderId: context.orderId } : {}),
      payload,
    };
  }
}
