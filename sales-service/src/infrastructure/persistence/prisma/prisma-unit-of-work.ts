import type { PrismaClient } from '@prisma/client';
import { TransactionalContext, UnitOfWork } from '../../../application/ports/unit-of-work';
import { PrismaOrderRepository } from './prisma-order-repository';
import { PrismaOutboxRepository } from './prisma-outbox-repository';

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { maxWaitMs?: number; timeoutMs?: number } = {},
  ) {}

  /**
   * Transação curta e sem I/O externo dentro dela.
   *
   * Os passos da SAGA chamam parceiros **fora** da transação e só abrem o
   * commit para gravar o resultado. Manter uma chamada HTTP dentro de uma
   * transação seguraria a conexão do banco pelo tempo da rede — e uma
   * lentidão do provedor de pagamento viraria esgotamento do pool.
   */
  async execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (tx) =>
        work({
          orders: new PrismaOrderRepository(tx),
          outbox: new PrismaOutboxRepository(tx),
        }),
      {
        maxWait: this.options.maxWaitMs ?? 5_000,
        timeout: this.options.timeoutMs ?? 10_000,
      },
    );
  }
}
