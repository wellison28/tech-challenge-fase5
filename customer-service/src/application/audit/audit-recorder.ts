import {
  AccessOutcome,
  DataAccessAction,
  DataAccessLog,
} from '../../domain/entities/data-access-log';
import { DataAccessLogRepository } from '../../domain/repositories/data-access-log-repository';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { IdGenerator } from '../ports/id-generator';

/**
 * Fábrica e gravador da trilha de auditoria.
 *
 * Centralizado para que nenhum caso de uso possa "esquecer" de registrar um
 * acesso — e para que o formato do registro seja idêntico em todos eles, o que
 * é pré-requisito para consultar a trilha de forma confiável.
 */
export class AuditRecorder {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async allowed(
    repository: DataAccessLogRepository,
    params: {
      customerId: string;
      action: DataAccessAction;
      fieldsAccessed?: string[];
      context: AccessContext;
    },
  ): Promise<void> {
    await this.write(repository, {
      ...params,
      outcome: AccessOutcome.ALLOWED,
      denialReason: null,
    });
  }

  async denied(
    repository: DataAccessLogRepository,
    params: {
      customerId: string;
      action: DataAccessAction;
      reason: string;
      context: AccessContext;
    },
  ): Promise<void> {
    await this.write(repository, {
      customerId: params.customerId,
      action: params.action,
      context: params.context,
      outcome: AccessOutcome.DENIED,
      denialReason: params.reason,
    });
  }

  private async write(
    repository: DataAccessLogRepository,
    params: {
      customerId: string;
      action: DataAccessAction;
      fieldsAccessed?: string[];
      outcome: AccessOutcome;
      denialReason: string | null;
      context: AccessContext;
    },
  ): Promise<void> {
    await repository.append(
      DataAccessLog.record({
        id: this.ids.generate(),
        customerId: params.customerId,
        actorId: params.context.actorId,
        actorType: params.context.actorType,
        actorRoles: params.context.actorRoles,
        action: params.action,
        purpose: params.context.purpose,
        fieldsAccessed: params.fieldsAccessed ?? [],
        outcome: params.outcome,
        denialReason: params.denialReason,
        correlationId: params.context.correlationId,
        sourceIp: params.context.sourceIp ?? null,
        userAgent: params.context.userAgent ?? null,
        occurredAt: this.clock.now(),
      }),
    );
  }
}
