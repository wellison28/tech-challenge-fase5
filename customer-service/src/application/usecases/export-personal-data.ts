import { ConsentPurpose } from '../../domain/entities/consent';
import { DataAccessAction } from '../../domain/entities/data-access-log';
import { DataProtectionError, NotFoundError } from '../../domain/errors/domain-error';
import { AuditRecorder } from '../audit/audit-recorder';
import {
  AccessLogEntryDTO,
  BILLING_FIELDS,
  DOCUMENTATION_FIELDS,
  SensitiveCustomerDTO,
  toAccessLogEntryDTO,
  toSensitiveCustomerDTO,
} from '../dto/customer-dto';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface BillingProfile {
  customerId: string;
  fullName: string;
  cpf: string;
  email: string;
  phone: string;
}

export interface DocumentationDossier {
  customerId: string;
  fullName: string;
  cpf: string;
  birthDate: string;
  identityDocument: { type: string; number: string; issuer: string };
  address: NonNullable<SensitiveCustomerDTO['address']>;
}

/**
 * Os **únicos** três caminhos pelos quais dado pessoal em claro sai deste
 * serviço. Todos exigem escopo máquina-a-máquina próprio, finalidade declarada
 * e produzem registro de auditoria na mesma transação da leitura.
 *
 *  1. `billingProfile`       — emissão do código de pagamento.
 *  2. `documentationDossier` — emissão do ATPV-e na retirada do veículo.
 *  3. `dataSubjectExport`    — portabilidade ao próprio titular (art. 18, V).
 *
 * Alternativa considerada e descartada: emitir um *token de pagador* de uso
 * único, trocado pelo gateway no momento da cobrança, para que o dado nunca
 * transitasse pelo sales-service. Foi descartada por acrescentar um estado
 * distribuído a mais (o token e seu TTL) sem eliminar a exposição — o gateway
 * continuaria recebendo o CPF. A mitigação adotada é contratual e técnica: o
 * sales-service não persiste o retorno, e o tráfego é interno à VPC.
 */
export class ExportPersonalDataUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
  ) {}

  async billingProfile(customerId: string, context: AccessContext): Promise<BillingProfile> {
    return this.uow.execute(async (ctx) => {
      const customer = await this.loadEligible(ctx, customerId, context, DataAccessAction.EXPORT_FOR_BILLING);

      const data = toSensitiveCustomerDTO(customer);
      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.EXPORT_FOR_BILLING,
        fieldsAccessed: [...BILLING_FIELDS],
        context,
      });

      return {
        customerId,
        fullName: data.fullName!,
        cpf: data.cpf!,
        email: data.email!,
        phone: data.phone!,
      };
    });
  }

  async documentationDossier(
    customerId: string,
    context: AccessContext,
  ): Promise<DocumentationDossier> {
    return this.uow.execute(async (ctx) => {
      const customer = await this.loadEligible(
        ctx,
        customerId,
        context,
        DataAccessAction.EXPORT_FOR_DOCUMENTATION,
      );

      const data = toSensitiveCustomerDTO(customer);
      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.EXPORT_FOR_DOCUMENTATION,
        fieldsAccessed: [...DOCUMENTATION_FIELDS],
        context,
      });

      return {
        customerId,
        fullName: data.fullName!,
        cpf: data.cpf!,
        birthDate: data.birthDate!,
        identityDocument: data.identityDocument!,
        address: data.address!,
      };
    });
  }

  /** Portabilidade: o titular recebe tudo o que a plataforma guarda sobre ele. */
  async dataSubjectExport(
    customerId: string,
    context: AccessContext,
  ): Promise<{ personalData: SensitiveCustomerDTO; accessLog: AccessLogEntryDTO[] }> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(customerId);
      if (!customer) {
        throw new NotFoundError('Cliente', customerId);
      }
      if (customer.isAnonymized) {
        throw new DataProtectionError('Cadastro já anonimizado: não há dados a exportar', {
          customerId,
        });
      }

      const accessLog = await ctx.auditLog.listByCustomer(customerId, 500);

      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.DATA_SUBJECT_EXPORT,
        fieldsAccessed: ['*'],
        context,
      });

      return {
        personalData: toSensitiveCustomerDTO(customer),
        accessLog: accessLog.map(toAccessLogEntryDTO),
      };
    });
  }

  /**
   * Carrega o cadastro e verifica a base legal antes de decifrar qualquer campo.
   * Toda negativa também vira registro de auditoria — é o que permite detectar
   * um serviço tentando ler dado sem finalidade válida.
   */
  private async loadEligible(
    ctx: { customers: { findById: (id: string) => Promise<import('../../domain/entities/customer').Customer | null> }; auditLog: import('../../domain/repositories/data-access-log-repository').DataAccessLogRepository },
    customerId: string,
    context: AccessContext,
    action: DataAccessAction,
  ) {
    const customer = await ctx.customers.findById(customerId);
    if (!customer) {
      await this.audit.denied(ctx.auditLog, {
        customerId, action, reason: 'CLIENTE_NAO_ENCONTRADO', context,
      });
      throw new NotFoundError('Cliente', customerId);
    }

    if (customer.isAnonymized) {
      await this.audit.denied(ctx.auditLog, {
        customerId, action, reason: 'CADASTRO_ANONIMIZADO', context,
      });
      throw new DataProtectionError('Cadastro anonimizado: não há dados pessoais a fornecer', {
        customerId,
      });
    }

    if (!customer.hasActiveConsent(ConsentPurpose.DOCUMENT_ISSUANCE)) {
      await this.audit.denied(ctx.auditLog, {
        customerId, action, reason: 'BASE_LEGAL_AUSENTE', context,
      });
      throw new DataProtectionError(
        'Não há base legal vigente para fornecer os dados pessoais deste titular',
        { customerId },
      );
    }

    const eligibility = customer.checkPurchaseEligibility(this.clock.now());
    if (!eligibility.eligible) {
      await this.audit.denied(ctx.auditLog, {
        customerId, action, reason: eligibility.reasons.join(','), context,
      });
      throw new DataProtectionError('Cadastro não habilitado para a operação de compra', {
        customerId,
        reasons: eligibility.reasons,
      });
    }

    return customer;
  }
}
