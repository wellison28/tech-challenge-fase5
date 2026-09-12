import type { Prisma, PrismaClient } from '@prisma/client';
import { DataAccessLog, DataAccessLogProps } from '../../../domain/entities/data-access-log';
import { DataAccessLogRepository } from '../../../domain/repositories/data-access-log-repository';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Adaptador da trilha de auditoria.
 *
 * Expõe apenas `append` e `listByCustomer`: não há método de atualização nem
 * de remoção, e o papel de banco usado pela aplicação também não tem essas
 * permissões. A restrição existe nas duas camadas de propósito — a interface
 * documenta a intenção, o GRANT a impõe.
 */
export class PrismaDataAccessLogRepository implements DataAccessLogRepository {
  constructor(private readonly client: Client) {}

  async append(log: DataAccessLog): Promise<void> {
    const props = log.toJSON();
    await this.client.dataAccessLog.create({
      data: {
        id: props.id,
        customerId: props.customerId,
        actorId: props.actorId,
        actorType: props.actorType,
        actorRoles: props.actorRoles,
        action: props.action,
        purpose: props.purpose,
        fieldsAccessed: props.fieldsAccessed,
        outcome: props.outcome,
        denialReason: props.denialReason,
        correlationId: props.correlationId,
        sourceIp: props.sourceIp,
        userAgent: props.userAgent,
        occurredAt: props.occurredAt,
      },
    });
  }

  async listByCustomer(customerId: string, limit: number): Promise<DataAccessLogProps[]> {
    const rows = await this.client.dataAccessLog.findMany({
      where: { customerId },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      actorId: row.actorId,
      actorType: row.actorType as 'USER' | 'SERVICE',
      actorRoles: row.actorRoles,
      action: row.action,
      purpose: row.purpose,
      fieldsAccessed: row.fieldsAccessed,
      outcome: row.outcome,
      denialReason: row.denialReason,
      correlationId: row.correlationId,
      sourceIp: row.sourceIp,
      userAgent: row.userAgent,
      occurredAt: row.occurredAt,
    }));
  }
}
