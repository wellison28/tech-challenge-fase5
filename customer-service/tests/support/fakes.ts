import { Clock } from '../../src/application/ports/clock';
import { EventPublisher } from '../../src/application/ports/event-publisher';
import { IdGenerator } from '../../src/application/ports/id-generator';
import { DomainEvent } from '../../src/domain/events/domain-event';

/** Relógio controlável: torna determinístico tudo que depende de TTL e expiração. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-01-15T10:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }

  set(date: Date): void {
    this.current = date;
  }
}

/** UUIDs previsíveis, para asserções legíveis. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = '00000000-0000-4000-8000') {}

  generate(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter).padStart(12, '0')}`;
  }
}

export class RecordingEventPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];
  shouldFail = false;

  async publish(events: DomainEvent[]): Promise<void> {
    if (this.shouldFail) {
      throw new Error('falha simulada no barramento');
    }
    this.published.push(...events);
  }
}

/** CPFs válidos (dígitos verificadores corretos) para uso nos testes. */
export const VALID_CPF = '52998224725';
export const VALID_CPF_2 = '11144477735';
export const VALID_CPF_3 = '39053344705';
