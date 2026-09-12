import type { PrismaClient } from '@prisma/client';
import { BlindIndex, FieldCipher } from '../../../application/ports/crypto';
import { TransactionalContext, UnitOfWork } from '../../../application/ports/unit-of-work';
import { CustomerMapper } from './customer-mapper';
import { PrismaCustomerRepository } from './prisma-customer-repository';
import { PrismaDataAccessLogRepository } from './prisma-data-access-log-repository';
import { PrismaOutboxRepository } from './prisma-outbox-repository';

export class PrismaUnitOfWork implements UnitOfWork {
  private readonly mapper: CustomerMapper;

  constructor(
    private readonly prisma: PrismaClient,
    cipher: FieldCipher,
    private readonly blindIndex: BlindIndex,
    private readonly blindIndexVersion = 1,
    private readonly options: { maxWaitMs?: number; timeoutMs?: number } = {},
  ) {
    this.mapper = new CustomerMapper(cipher);
  }

  /**
   * A auditoria participa da mesma transação da operação auditada: ou as duas
   * escritas são efetivadas, ou nenhuma. Não existe acesso a dado pessoal sem
   * rastro correspondente.
   */
  async execute<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (tx) =>
        work({
          customers: new PrismaCustomerRepository(
            tx,
            this.mapper,
            this.blindIndex,
            this.blindIndexVersion,
          ),
          auditLog: new PrismaDataAccessLogRepository(tx),
          outbox: new PrismaOutboxRepository(tx),
        }),
      {
        maxWait: this.options.maxWaitMs ?? 5_000,
        // Mais longo que no vehicle-service: cada leitura pode incluir uma
        // chamada de rede ao KMS para abrir a chave de dados.
        timeout: this.options.timeoutMs ?? 15_000,
      },
    );
  }
}
