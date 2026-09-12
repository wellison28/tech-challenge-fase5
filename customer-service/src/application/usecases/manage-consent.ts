import { ConsentPurpose } from '../../domain/entities/consent';
import { DataAccessAction } from '../../domain/entities/data-access-log';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { ConsentChangedPayload, CustomerEventType } from '../../domain/events/domain-event';
import { AuditRecorder } from '../audit/audit-recorder';
import { MaskedCustomerDTO, toMaskedCustomerDTO } from '../dto/customer-dto';
import { EventFactory } from '../events/event-factory';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

/**
 * Gestão de consentimento (LGPD arts. 8º e 18, IX).
 *
 * A revogação precisa ser tão fácil quanto o consentimento (art. 8º, §5º) —
 * por isso é um endpoint próprio, no mesmo nível do cadastro, e não um pedido
 * por e-mail ou um formulário escondido.
 */
export class ManageConsentUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly audit: AuditRecorder,
    private readonly policyVersion: string,
  ) {}

  async grant(params: {
    customerId: string;
    purpose: ConsentPurpose;
    source: 'WEB_FORM' | 'MOBILE_APP' | 'IN_STORE' | 'MIGRATION';
    context: AccessContext;
  }): Promise<MaskedCustomerDTO> {
    return this.apply(params.customerId, params.context, (customer, now) => {
      customer.grantConsent(params.purpose, this.policyVersion, params.source, now);
      return { purpose: params.purpose, granted: true };
    });
  }

  async revoke(params: {
    customerId: string;
    purpose: ConsentPurpose;
    context: AccessContext;
  }): Promise<MaskedCustomerDTO> {
    return this.apply(params.customerId, params.context, (customer, now) => {
      customer.revokeConsent(params.purpose, now);
      return { purpose: params.purpose, granted: false };
    });
  }

  private async apply(
    customerId: string,
    context: AccessContext,
    mutate: (
      customer: import('../../domain/entities/customer').Customer,
      now: Date,
    ) => { purpose: ConsentPurpose; granted: boolean },
  ): Promise<MaskedCustomerDTO> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(customerId);
      if (!customer) {
        throw new NotFoundError('Cliente', customerId);
      }

      const versionBeforeUpdate = customer.version;
      const change = mutate(customer, this.clock.now());

      if (!(await ctx.customers.update(customer, versionBeforeUpdate))) {
        throw new ConflictError('Conflito de concorrência ao registrar o consentimento', {
          customerId,
        });
      }

      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.CONSENT_CHANGE,
        fieldsAccessed: [`consent:${change.purpose}`],
        context,
      });

      await ctx.outbox.enqueue(
        this.events.build<ConsentChangedPayload>(
          change.granted ? CustomerEventType.CONSENT_GRANTED : CustomerEventType.CONSENT_REVOKED,
          customerId,
          {
            customerId,
            purpose: change.purpose,
            granted: change.granted,
            policyVersion: this.policyVersion,
          },
          context.correlationId,
        ),
      );

      return toMaskedCustomerDTO(customer);
    });
  }
}
