import { ConflictError, DataProtectionError, ValidationError } from '../errors/domain-error';
import { Address } from '../value-objects/address';
import { Cpf } from '../value-objects/cpf';
import { Email } from '../value-objects/email';
import { IdentityDocument } from '../value-objects/identity-document';
import { Phone } from '../value-objects/phone';
import { Consent, ConsentPurpose, ESSENTIAL_PURPOSES } from './consent';

export const CustomerStatus = {
  /** Cadastro criado; e-mail ainda não confirmado. Não pode comprar. */
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  /** Bloqueado por decisão da revenda (fraude, inadimplência). */
  BLOCKED: 'BLOCKED',
  /** Direito de eliminação exercido (LGPD art. 18, VI). Estado terminal. */
  ANONYMIZED: 'ANONYMIZED',
} as const;
export type CustomerStatus = (typeof CustomerStatus)[keyof typeof CustomerStatus];

const MINIMUM_AGE_YEARS = 18;
const MAXIMUM_AGE_YEARS = 120;

export interface CustomerProps {
  id: string;
  fullName: string | null;
  cpf: Cpf | null;
  birthDate: Date | null;
  email: Email | null;
  phone: Phone | null;
  address: Address | null;
  identityDocument: IdentityDocument | null;
  status: CustomerStatus;
  consents: Map<ConsentPurpose, Consent>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  anonymizedAt: Date | null;
}

export interface CreateCustomerInput {
  id: string;
  fullName: string;
  cpf: string;
  birthDate: Date;
  email: string;
  phone: string;
  address: Parameters<typeof Address.create>[0];
  identityDocument: Parameters<typeof IdentityDocument.create>[0];
  policyVersion: string;
  consentSource: 'WEB_FORM' | 'MOBILE_APP' | 'IN_STORE' | 'MIGRATION';
  /** Finalidades opcionais que o titular marcou no formulário. */
  optionalConsents?: ConsentPurpose[];
  now: Date;
}

/**
 * Agregado do comprador.
 *
 * Concentra **todo** o dado pessoal da plataforma. Os outros dois serviços
 * conhecem apenas o `customerId` (um UUID opaco) — é a aplicação prática da
 * minimização: um vazamento no catálogo ou no serviço de vendas não expõe
 * nenhum titular.
 *
 * Os campos são anuláveis porque a anonimização (art. 18, VI) os apaga
 * mantendo o `id`, que continua referenciado pelas vendas já realizadas e
 * sujeitas à guarda fiscal obrigatória.
 */
export class Customer {
  private constructor(private props: CustomerProps) {}

  // ---------------------------------------------------------------------------
  // Construção
  // ---------------------------------------------------------------------------

  static create(input: CreateCustomerInput): Customer {
    const fullName = Customer.assertFullName(input.fullName);
    Customer.assertAge(input.birthDate, input.now);

    const consents = new Map<ConsentPurpose, Consent>();
    // As finalidades essenciais são registradas na criação: sem elas não existe
    // contrato de compra e venda a executar.
    for (const purpose of [...ESSENTIAL_PURPOSES, ...(input.optionalConsents ?? [])]) {
      consents.set(
        purpose,
        Consent.grant({
          purpose,
          policyVersion: input.policyVersion,
          source: input.consentSource,
          now: input.now,
        }),
      );
    }

    return new Customer({
      id: input.id,
      fullName,
      cpf: Cpf.create(input.cpf),
      birthDate: input.birthDate,
      email: Email.create(input.email),
      phone: Phone.create(input.phone),
      address: Address.create(input.address),
      identityDocument: IdentityDocument.create(input.identityDocument),
      status: CustomerStatus.PENDING_VERIFICATION,
      consents,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
      anonymizedAt: null,
    });
  }

  static restore(props: CustomerProps): Customer {
    return new Customer({ ...props, consents: new Map(props.consents) });
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  /** Confirmação de e-mail: libera o cadastro para comprar. */
  activate(now: Date): void {
    this.assertNotAnonymized();
    if (this.props.status === CustomerStatus.BLOCKED) {
      throw new ConflictError('Cadastro bloqueado não pode ser ativado sem revisão', {
        customerId: this.props.id,
      });
    }
    this.props.status = CustomerStatus.ACTIVE;
    this.touch(now);
  }

  block(now: Date): void {
    this.assertNotAnonymized();
    this.props.status = CustomerStatus.BLOCKED;
    this.touch(now);
  }

  updateContact(
    input: {
      fullName?: string;
      email?: string;
      phone?: string;
      address?: Parameters<typeof Address.create>[0];
      identityDocument?: Parameters<typeof IdentityDocument.create>[0];
    },
    now: Date,
  ): void {
    this.assertNotAnonymized();

    if (input.fullName !== undefined) {
      this.props.fullName = Customer.assertFullName(input.fullName);
    }
    if (input.email !== undefined) this.props.email = Email.create(input.email);
    if (input.phone !== undefined) this.props.phone = Phone.create(input.phone);
    if (input.address !== undefined) this.props.address = Address.create(input.address);
    if (input.identityDocument !== undefined) {
      this.props.identityDocument = IdentityDocument.create(input.identityDocument);
    }

    this.touch(now);
  }

  /**
   * Direito de eliminação (LGPD art. 18, VI).
   *
   * Não apaga a linha: sobrescreve todo dado pessoal e mantém o `id` e as datas.
   * O motivo é que as vendas concluídas têm guarda fiscal obrigatória — apagar
   * a linha quebraria a integridade referencial do histórico e descumpriria
   * outra obrigação legal. O resultado é um registro que não identifica
   * ninguém, exatamente o que a lei pede.
   */
  anonymize(now: Date): void {
    if (this.props.status === CustomerStatus.ANONYMIZED) {
      return; // idempotente
    }

    this.props.fullName = null;
    this.props.cpf = null;
    this.props.birthDate = null;
    this.props.email = null;
    this.props.phone = null;
    this.props.address = null;
    this.props.identityDocument = null;
    this.props.consents = new Map();
    this.props.status = CustomerStatus.ANONYMIZED;
    this.props.anonymizedAt = now;
    this.touch(now);
  }

  // ---------------------------------------------------------------------------
  // Consentimento
  // ---------------------------------------------------------------------------

  grantConsent(
    purpose: ConsentPurpose,
    policyVersion: string,
    source: 'WEB_FORM' | 'MOBILE_APP' | 'IN_STORE' | 'MIGRATION',
    now: Date,
  ): void {
    this.assertNotAnonymized();

    const existing = this.props.consents.get(purpose);
    if (existing) {
      existing.regrant(policyVersion, source, now);
    } else {
      this.props.consents.set(purpose, Consent.grant({ purpose, policyVersion, source, now }));
    }
    this.touch(now);
  }

  revokeConsent(purpose: ConsentPurpose, now: Date): void {
    this.assertNotAnonymized();

    const consent = this.props.consents.get(purpose);
    if (!consent) {
      throw new ValidationError('Não há consentimento registrado para esta finalidade', {
        purpose,
      });
    }
    consent.revoke(now);
    this.touch(now);
  }

  hasActiveConsent(purpose: ConsentPurpose): boolean {
    return this.props.consents.get(purpose)?.granted ?? false;
  }

  // ---------------------------------------------------------------------------
  // Elegibilidade para comprar (consultada pela SAGA)
  // ---------------------------------------------------------------------------

  /**
   * Requisito do enunciado: "efetuar a venda somente para compradores
   * cadastrados". A verificação vai além da existência do cadastro — exige
   * cadastro ativo, base legal vigente e capacidade civil.
   */
  checkPurchaseEligibility(now: Date): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (this.props.status === CustomerStatus.ANONYMIZED) {
      reasons.push('CADASTRO_ANONIMIZADO');
    }
    if (this.props.status === CustomerStatus.BLOCKED) {
      reasons.push('CADASTRO_BLOQUEADO');
    }
    if (this.props.status === CustomerStatus.PENDING_VERIFICATION) {
      reasons.push('EMAIL_NAO_VERIFICADO');
    }
    for (const purpose of ESSENTIAL_PURPOSES) {
      if (!this.hasActiveConsent(purpose)) {
        reasons.push(`CONSENTIMENTO_AUSENTE:${purpose}`);
      }
    }
    if (!this.props.cpf || !this.props.address || !this.props.identityDocument) {
      reasons.push('CADASTRO_INCOMPLETO');
    }
    if (this.props.birthDate && Customer.ageInYears(this.props.birthDate, now) < MINIMUM_AGE_YEARS) {
      reasons.push('MENOR_DE_IDADE');
    }

    return { eligible: reasons.length === 0, reasons };
  }

  // ---------------------------------------------------------------------------
  // Acessores
  // ---------------------------------------------------------------------------

  get id(): string { return this.props.id; }
  get fullName(): string | null { return this.props.fullName; }
  get cpf(): Cpf | null { return this.props.cpf; }
  get birthDate(): Date | null { return this.props.birthDate; }
  get email(): Email | null { return this.props.email; }
  get phone(): Phone | null { return this.props.phone; }
  get address(): Address | null { return this.props.address; }
  get identityDocument(): IdentityDocument | null { return this.props.identityDocument; }
  get status(): CustomerStatus { return this.props.status; }
  get consents(): Consent[] { return [...this.props.consents.values()]; }
  get version(): number { return this.props.version; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }
  get anonymizedAt(): Date | null { return this.props.anonymizedAt; }
  get isAnonymized(): boolean { return this.props.status === CustomerStatus.ANONYMIZED; }

  toSnapshot(): CustomerProps {
    return { ...this.props, consents: new Map(this.props.consents) };
  }

  // ---------------------------------------------------------------------------
  // Invariantes
  // ---------------------------------------------------------------------------

  private assertNotAnonymized(): void {
    if (this.props.status === CustomerStatus.ANONYMIZED) {
      throw new DataProtectionError(
        'Cadastro anonimizado a pedido do titular: nenhuma operação sobre dados pessoais é permitida',
        { customerId: this.props.id },
      );
    }
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
    this.props.version += 1;
  }

  private static assertFullName(value: string): string {
    const normalized = (value ?? '').trim().replace(/\s+/g, ' ');
    if (normalized.length < 3 || normalized.length > 150) {
      throw new ValidationError('Nome completo deve ter entre 3 e 150 caracteres');
    }
    if (!normalized.includes(' ')) {
      throw new ValidationError('Informe o nome completo (nome e sobrenome)');
    }
    return normalized;
  }

  private static assertAge(birthDate: Date, now: Date): void {
    if (Number.isNaN(birthDate.getTime())) {
      throw new ValidationError('Data de nascimento inválida');
    }
    if (birthDate.getTime() > now.getTime()) {
      throw new ValidationError('Data de nascimento não pode estar no futuro');
    }

    const age = Customer.ageInYears(birthDate, now);
    if (age < MINIMUM_AGE_YEARS) {
      throw new ValidationError(
        `O comprador deve ter ao menos ${MINIMUM_AGE_YEARS} anos para adquirir um veículo`,
      );
    }
    if (age > MAXIMUM_AGE_YEARS) {
      throw new ValidationError('Data de nascimento implausível');
    }
  }

  private static ageInYears(birthDate: Date, now: Date): number {
    let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - birthDate.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birthDate.getUTCDate())) {
      age -= 1;
    }
    return age;
  }
}
