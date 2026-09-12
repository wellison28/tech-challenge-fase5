import type { PrismaClient } from '@prisma/client';
import { TransactionalContext, UnitOfWork } from '../../../application/ports/unit-of-work';
import { PrismaOutboxRepository } from './prisma-outbox-repository';
import { PrismaVehicleRepository } from './prisma-vehicle-repository';

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { maxWaitMs?: number; timeoutMs?: number } = {},
  ) {}

  /**
   * Abre uma transação e entrega ao caso de uso os repositórios ligados a ela.
   * Mudança de estado e gravação no outbox compartilham o mesmo commit — é o
   * que torna a publicação de eventos confiável.
   */
  async execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (tx) =>
        work({
          vehicles: new PrismaVehicleRepository(tx),
          outbox: new PrismaOutboxRepository(tx),
        }),
      {
        maxWait: this.options.maxWaitMs ?? 5_000,
        // Curto de propósito: em Lambda, uma transação longa segura conexão do
        // pool e aumenta o risco de timeout do API Gateway (29s).
        timeout: this.options.timeoutMs ?? 10_000,
      },
    );
  }
}
