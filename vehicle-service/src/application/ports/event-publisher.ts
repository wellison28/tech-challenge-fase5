import { DomainEvent } from '../../domain/events/domain-event';

export interface EventPublisher {
  publish(events: DomainEvent[]): Promise<void>;
}
