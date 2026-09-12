import { DataAccessAction } from '../../domain/entities/data-access-log';
import { ConflictError, DuplicateResourceError, NotFoundError } from '../../domain/errors/domain-error';
import { CustomerEventType, CustomerLifecyclePayload } from '../../domain/events/domain-event';
import { Email } from '../../domain/value-objects/email';
import { AuditRecorder } from '../audit/audit-recorder';
import { MaskedCustomerDTO, toMaskedCustomerDTO } from '../dto/customer-dto';
import { EventFactory } from '../events/event-factory';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface UpdateCustomerCommand {
  customerId: string;
  fullName?: string;
  email?: string;
  phone?: string;
  address?: {
    zipCode: string;
    street: string;
    number: string;
    complement?: string | null;
    district: string;
    city: string;
    state: string;
  };
  identityDocument?: { type: string; number: string; issuer: string };
  context: AccessContext;
}

/**
 * Atualização cadastral.
 *
 * O CPF não é editável: é a chave natural do titular e a base do índice cego.
 * Corrigir um CPF digitado errado é, do ponto de vista de negócio, cadastrar
 * outra pessoa — exige novo cadastro e tratamento do registro incorreto.
 */
export class UpdateCustomerUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly audit: AuditRecorder,
  ) {}

  async execute(command: UpdateCustomerCommand): Promise<MaskedCustomerDTO> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(command.customerId);
      if (!customer) {
        throw new NotFoundError('Cliente', command.customerId);
      }

      if (command.email) {
        const email = Email.create(command.email);
        const owner = await ctx.customers.findByEmail(email);
        if (owner && owner.id !== customer.id) {
          throw new DuplicateResourceError('e-mail', email.mask());
        }
      }

      const versionBeforeUpdate = customer.version;
      customer.updateContact(command, this.clock.now());

      if (!(await ctx.customers.update(customer, versionBeforeUpdate))) {
        throw new ConflictError('O cadastro foi alterado por outra operação; recarregue os dados', {
          customerId: customer.id,
        });
      }

      await this.audit.allowed(ctx.auditLog, {
        customerId: customer.id,
        action: DataAccessAction.UPDATE,
        fieldsAccessed: Object.keys(command).filter(
          (key) => !['customerId', 'context'].includes(key),
        ),
        context: command.context,
      });

      await ctx.outbox.enqueue(
        this.events.build<CustomerLifecyclePayload>(
          CustomerEventType.UPDATED,
          customer.id,
          { customerId: customer.id, status: customer.status },
          command.context.correlationId,
        ),
      );

      return toMaskedCustomerDTO(customer);
    });
  }
}
