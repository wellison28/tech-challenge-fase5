import { Customer } from '../../domain/entities/customer';
import { ConsentPurpose } from '../../domain/entities/consent';
import { DataAccessAction } from '../../domain/entities/data-access-log';
import { DuplicateResourceError } from '../../domain/errors/domain-error';
import { CustomerEventType, CustomerLifecyclePayload } from '../../domain/events/domain-event';
import { Cpf } from '../../domain/value-objects/cpf';
import { Email } from '../../domain/value-objects/email';
import { AuditRecorder } from '../audit/audit-recorder';
import { MaskedCustomerDTO, toMaskedCustomerDTO } from '../dto/customer-dto';
import { EventFactory } from '../events/event-factory';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface RegisterCustomerCommand {
  /**
   * `sub` da conta do comprador no Cognito. O cadastro usa o mesmo identificador
   * da identidade: é o que permite ao titular autenticado alcançar o próprio
   * cadastro, e ao sales-service abrir o pedido em nome de quem está logado.
   */
  customerId: string;
  fullName: string;
  cpf: string;
  birthDate: string;
  email: string;
  phone: string;
  address: {
    zipCode: string;
    street: string;
    number: string;
    complement?: string | null;
    district: string;
    city: string;
    state: string;
  };
  identityDocument: { type: string; number: string; issuer: string };
  consentSource: 'WEB_FORM' | 'MOBILE_APP' | 'IN_STORE' | 'MIGRATION';
  optionalConsents?: ConsentPurpose[];
  context: AccessContext;
}

/**
 * Cadastro de comprador.
 *
 * A resposta é mascarada mesmo para quem acabou de enviar os dados: o cliente
 * já tem o que digitou, e devolver o CPF em claro só o espalharia para o log
 * do navegador, do CDN e do próprio frontend.
 */
export class RegisterCustomerUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly audit: AuditRecorder,
    private readonly policyVersion: string,
  ) {}

  async execute(command: RegisterCustomerCommand): Promise<MaskedCustomerDTO> {
    const now = this.clock.now();
    const cpf = Cpf.create(command.cpf);
    const email = Email.create(command.email);

    const customer = Customer.create({
      id: command.customerId,
      fullName: command.fullName,
      cpf: cpf.value,
      birthDate: new Date(command.birthDate),
      email: email.value,
      phone: command.phone,
      address: command.address,
      identityDocument: command.identityDocument,
      policyVersion: this.policyVersion,
      consentSource: command.consentSource,
      optionalConsents: command.optionalConsents,
      now,
    });

    return this.uow.execute(async (ctx) => {
      // A checagem de duplicidade usa o índice cego por baixo: nenhuma consulta
      // percorre CPFs em claro.
      if (await ctx.customers.findByCpf(cpf)) {
        throw new DuplicateResourceError('CPF', cpf.mask());
      }
      if (await ctx.customers.findByEmail(email)) {
        throw new DuplicateResourceError('e-mail', email.mask());
      }
      // Uma conta, um cadastro: sem isto, a mesma identidade teria duas fichas
      // e o `sub` do token deixaria de apontar para um titular único.
      if (await ctx.customers.findById(command.customerId)) {
        throw new DuplicateResourceError('conta', command.customerId);
      }

      await ctx.customers.create(customer);

      await this.audit.allowed(ctx.auditLog, {
        customerId: customer.id,
        action: DataAccessAction.CREATE,
        fieldsAccessed: ['fullName', 'cpf', 'birthDate', 'email', 'phone', 'address', 'identityDocument'],
        context: command.context,
      });

      await ctx.outbox.enqueue(
        this.events.build<CustomerLifecyclePayload>(
          CustomerEventType.REGISTERED,
          customer.id,
          { customerId: customer.id, status: customer.status },
          command.context.correlationId,
        ),
      );

      return toMaskedCustomerDTO(customer);
    });
  }
}
