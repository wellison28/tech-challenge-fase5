import {
  EventBridgeClient,
  PutEventsCommand,
  PutEventsRequestEntry,
} from '@aws-sdk/client-eventbridge';
import { EventPublisher } from '../../application/ports/event-publisher';
import { DomainEvent } from '../../domain/events/domain-event';

const MAX_ENTRIES_PER_CALL = 10; // limite da API PutEvents

/**
 * Publica eventos de domínio no Amazon EventBridge.
 *
 * EventBridge (e não SNS/SQS direto) porque o roteamento fica declarado em
 * regras na infraestrutura, não no código: adicionar um novo consumidor de
 * `vehicle.sold` é criar uma regra, sem tocar neste serviço. Isso preserva o
 * baixo acoplamento entre os três microsserviços.
 */
export class EventBridgePublisher implements EventPublisher {
  private readonly client: EventBridgeClient;

  constructor(
    private readonly eventBusName: string,
    private readonly source: string,
    options: { region: string; endpoint?: string },
  ) {
    this.client = new EventBridgeClient({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += MAX_ENTRIES_PER_CALL) {
      const batch = events.slice(i, i + MAX_ENTRIES_PER_CALL);
      const entries: PutEventsRequestEntry[] = batch.map((event) => ({
        EventBusName: this.eventBusName,
        Source: this.source,
        DetailType: event.eventType,
        Detail: JSON.stringify(event),
        Time: new Date(event.occurredAt),
      }));

      const response = await this.client.send(new PutEventsCommand({ Entries: entries }));

      // PutEvents devolve 200 mesmo com falhas parciais: é preciso inspecionar
      // FailedEntryCount, ou eventos seriam marcados como publicados sem terem sido.
      if (response.FailedEntryCount && response.FailedEntryCount > 0) {
        const reasons = (response.Entries ?? [])
          .filter((entry) => entry.ErrorCode)
          .map((entry) => `${entry.ErrorCode}: ${entry.ErrorMessage}`)
          .join('; ');
        throw new Error(`Falha ao publicar ${response.FailedEntryCount} evento(s) — ${reasons}`);
      }
    }
  }
}

/** Publisher usado em desenvolvimento local e testes: só registra em log. */
export class LoggingEventPublisher implements EventPublisher {
  constructor(private readonly log: (message: string, payload: unknown) => void) {}

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.log(`[event] ${event.eventType}`, event);
    }
  }
}
