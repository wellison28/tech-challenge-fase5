/**
 * Envelope dos eventos de domínio do customer-service.
 *
 * Regra absoluta deste serviço: **nenhum evento carrega dado pessoal**.
 * Eventos vão para um barramento consumido por vários serviços e ficam
 * retidos em filas, DLQs e logs de entrega — é exatamente o tipo de lugar onde
 * um CPF acaba esquecido em texto claro. O payload leva apenas o `customerId`
 * opaco; quem precisar de dado pessoal pede pela API, sob escopo e auditoria.
 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  readonly eventId: string;
  readonly eventType: CustomerEventType;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly aggregateId: string;
  readonly aggregateType: 'customer';
  readonly correlationId: string;
  readonly payload: TPayload;
}

export const CustomerEventType = {
  REGISTERED: 'customer.registered',
  ACTIVATED: 'customer.activated',
  UPDATED: 'customer.updated',
  BLOCKED: 'customer.blocked',
  CONSENT_GRANTED: 'customer.consent_granted',
  CONSENT_REVOKED: 'customer.consent_revoked',
  ANONYMIZED: 'customer.anonymized',
} as const;
export type CustomerEventType = (typeof CustomerEventType)[keyof typeof CustomerEventType];

export interface CustomerLifecyclePayload {
  customerId: string;
  status: string;
  [key: string]: unknown;
}

export interface ConsentChangedPayload {
  customerId: string;
  purpose: string;
  granted: boolean;
  policyVersion: string;
  [key: string]: unknown;
}
