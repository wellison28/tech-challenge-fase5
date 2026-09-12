import { Customer } from '../../domain/entities/customer';

export interface ConsentDTO {
  purpose: string;
  granted: boolean;
  policyVersion: string;
  grantedAt: string | null;
  revokedAt: string | null;
  source: string;
}

/**
 * Representação **padrão** do cliente: mascarada.
 *
 * Esta é a resposta de toda rota de leitura comum. O dado em claro só sai pelos
 * dois endpoints de finalidade específica (cobrança e documentação), que exigem
 * escopo próprio e geram registro de auditoria. Mascarar por padrão inverte o
 * ônus: expor dado pessoal passa a exigir uma decisão explícita no código.
 */
export interface MaskedCustomerDTO {
  id: string;
  fullName: string | null;
  cpf: string | null;
  email: string | null;
  phone: string | null;
  /** Apenas cidade e UF — suficiente para atendimento, insuficiente para localizar o titular. */
  location: { city: string; state: string } | null;
  identityDocument: { type: string; number: string; issuer: string } | null;
  status: string;
  consents: ConsentDTO[];
  version: number;
  createdAt: string;
  updatedAt: string;
  anonymizedAt: string | null;
}

/** Dado pessoal em claro. Só é produzido em caminho auditado. */
export interface SensitiveCustomerDTO {
  id: string;
  fullName: string | null;
  cpf: string | null;
  cpfFormatted: string | null;
  birthDate: string | null;
  email: string | null;
  phone: string | null;
  address: {
    zipCode: string;
    street: string;
    number: string;
    complement: string | null;
    district: string;
    city: string;
    state: string;
  } | null;
  identityDocument: { type: string; number: string; issuer: string } | null;
  status: string;
}

function toConsentDTOs(customer: Customer): ConsentDTO[] {
  return customer.consents.map((consent) => ({
    purpose: consent.purpose,
    granted: consent.granted,
    policyVersion: consent.policyVersion,
    grantedAt: consent.grantedAt?.toISOString() ?? null,
    revokedAt: consent.revokedAt?.toISOString() ?? null,
    source: consent.source,
  }));
}

function maskName(fullName: string | null): string | null {
  if (!fullName) return null;
  const parts = fullName.split(' ');
  const first = parts[0] ?? '';
  // Mantém o primeiro nome e as iniciais: identifica o titular no atendimento
  // sem devolver o nome civil completo em uma listagem.
  const initials = parts.slice(1).map((part) => `${part.charAt(0)}.`);
  return [first, ...initials].join(' ');
}

export function toMaskedCustomerDTO(customer: Customer): MaskedCustomerDTO {
  return {
    id: customer.id,
    fullName: maskName(customer.fullName),
    cpf: customer.cpf?.mask() ?? null,
    email: customer.email?.mask() ?? null,
    phone: customer.phone?.mask() ?? null,
    location: customer.address?.toCoarseJSON() ?? null,
    identityDocument: customer.identityDocument?.mask() ?? null,
    status: customer.status,
    consents: toConsentDTOs(customer),
    version: customer.version,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
    anonymizedAt: customer.anonymizedAt?.toISOString() ?? null,
  };
}

export function toSensitiveCustomerDTO(customer: Customer): SensitiveCustomerDTO {
  return {
    id: customer.id,
    fullName: customer.fullName,
    cpf: customer.cpf?.value ?? null,
    cpfFormatted: customer.cpf?.format() ?? null,
    birthDate: customer.birthDate?.toISOString().slice(0, 10) ?? null,
    email: customer.email?.value ?? null,
    phone: customer.phone?.digits ?? null,
    address: customer.address?.toJSON() ?? null,
    identityDocument: customer.identityDocument?.toJSON() ?? null,
    status: customer.status,
  };
}

/** Campos devolvidos em claro em cada caminho auditado — usado na trilha. */
export const BILLING_FIELDS = ['fullName', 'cpf', 'email', 'phone'] as const;
export const DOCUMENTATION_FIELDS = [
  'fullName',
  'cpf',
  'birthDate',
  'identityDocument',
  'address',
] as const;

/** Entrada da trilha de auditoria como sai na API (datas em ISO 8601). */
export interface AccessLogEntryDTO {
  action: string;
  purpose: string;
  actorType: string;
  outcome: string;
  fieldsAccessed: string[];
  correlationId: string;
  occurredAt: string;
}

/**
 * Converte a trilha para saída.
 *
 * `actorId` e `sourceIp` são omitidos de propósito: o titular tem direito de
 * saber que houve acesso, para qual finalidade e quando — mas expor qual
 * funcionário consultou o cadastro transformaria um direito do titular em dado
 * pessoal de um terceiro. Essa informação existe na tabela e é fornecida à
 * ANPD ou ao jurídico por processo interno.
 */
export function toAccessLogEntryDTO(entry: {
  action: string;
  purpose: string;
  actorType: string;
  outcome: string;
  fieldsAccessed: string[];
  correlationId: string;
  occurredAt: Date;
}): AccessLogEntryDTO {
  return {
    action: entry.action,
    purpose: entry.purpose,
    actorType: entry.actorType,
    outcome: entry.outcome,
    fieldsAccessed: entry.fieldsAccessed,
    correlationId: entry.correlationId,
    occurredAt: entry.occurredAt.toISOString(),
  };
}
