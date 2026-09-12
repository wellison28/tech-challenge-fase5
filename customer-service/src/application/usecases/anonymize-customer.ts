import { DataAccessAction } from '../../domain/entities/data-access-log';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { CustomerEventType, CustomerLifecyclePayload } from '../../domain/events/domain-event';
import { AuditRecorder } from '../audit/audit-recorder';
import { EventFactory } from '../events/event-factory';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface AnonymizeCustomerResult {
  customerId: string;
  anonymizedAt: string;
  alreadyAnonymized: boolean;
}

/**
 * Direito de eliminação — LGPD art. 18, VI.
 *
 * Sobrescreve os dados pessoais e conserva a linha com o `id`, porque as
 * vendas concluídas estão sob guarda fiscal obrigatória e continuam
 * referenciando o comprador. O resultado satisfaz a lei: o registro
 * remanescente não identifica ninguém e não é reversível — a chave de dados
 * cifrada é descartada junto com o texto cifrado.
 *
 * O evento `customer.anonymized` avisa os demais serviços para que eles apaguem
 * qualquer dado derivado que ainda tenham em cache ou em projeções.
 */
export class AnonymizeCustomerUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly audit: AuditRecorder,
  ) {}

  async execute(customerId: string, context: AccessContext): Promise<AnonymizeCustomerResult> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(customerId);
      if (!customer) {
        throw new NotFoundError('Cliente', customerId);
      }

      if (customer.isAnonymized) {
        return {
          customerId,
          anonymizedAt: customer.anonymizedAt!.toISOString(),
          alreadyAnonymized: true,
        };
      }

      const versionBeforeUpdate = customer.version;
      const now = this.clock.now();
      customer.anonymize(now);

      if (!(await ctx.customers.update(customer, versionBeforeUpdate))) {
        throw new ConflictError('Conflito de concorrência ao anonimizar o cadastro', { customerId });
      }

      // A trilha de auditoria sobrevive à anonimização: ela não guarda dado
      // pessoal, apenas o identificador opaco, e é a prova de que o pedido do
      // titular foi atendido.
      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.ANONYMIZE,
        fieldsAccessed: ['fullName', 'cpf', 'birthDate', 'email', 'phone', 'address', 'identityDocument'],
        context,
      });

      await ctx.outbox.enqueue(
        this.events.build<CustomerLifecyclePayload>(
          CustomerEventType.ANONYMIZED,
          customerId,
          { customerId, status: customer.status },
          context.correlationId,
        ),
      );

      return { customerId, anonymizedAt: now.toISOString(), alreadyAnonymized: false };
    });
  }
}
