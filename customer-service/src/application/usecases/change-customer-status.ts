import { DataAccessAction } from '../../domain/entities/data-access-log';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { CustomerEventType, CustomerLifecyclePayload } from '../../domain/events/domain-event';
import { AuditRecorder } from '../audit/audit-recorder';
import { MaskedCustomerDTO, toMaskedCustomerDTO } from '../dto/customer-dto';
import { EventFactory } from '../events/event-factory';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

/** Ativação (confirmação de e-mail) e bloqueio administrativo do cadastro. */
export class ChangeCustomerStatusUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly audit: AuditRecorder,
  ) {}

  async activate(customerId: string, context: AccessContext): Promise<MaskedCustomerDTO> {
    return this.apply(customerId, context, 'activate');
  }

  async block(customerId: string, context: AccessContext): Promise<MaskedCustomerDTO> {
    return this.apply(customerId, context, 'block');
  }

  private async apply(
    customerId: string,
    context: AccessContext,
    operation: 'activate' | 'block',
  ): Promise<MaskedCustomerDTO> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(customerId);
      if (!customer) {
        throw new NotFoundError('Cliente', customerId);
      }

      const versionBeforeUpdate = customer.version;
      const now = this.clock.now();
      if (operation === 'activate') {
        customer.activate(now);
      } else {
        customer.block(now);
      }

      if (!(await ctx.customers.update(customer, versionBeforeUpdate))) {
        throw new ConflictError('Conflito de concorrência ao alterar o status do cadastro', {
          customerId,
        });
      }

      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.UPDATE,
        fieldsAccessed: ['status'],
        context,
      });

      await ctx.outbox.enqueue(
        this.events.build<CustomerLifecyclePayload>(
          operation === 'activate' ? CustomerEventType.ACTIVATED : CustomerEventType.BLOCKED,
          customerId,
          { customerId, status: customer.status },
          context.correlationId,
        ),
      );

      return toMaskedCustomerDTO(customer);
    });
  }
}
