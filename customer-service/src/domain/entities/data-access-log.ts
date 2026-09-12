/**
 * Registro imutável de acesso a dado pessoal.
 *
 * A LGPD exige que o controlador demonstre conformidade (art. 6º, X —
 * responsabilização e prestação de contas). Na prática isso significa poder
 * responder "quem viu o CPF deste titular, quando e por quê" — inclusive para
 * uma requisição do próprio titular ou da ANPD.
 *
 * A tabela é *append-only*: o papel da aplicação tem `INSERT` e `SELECT`, e
 * não tem `UPDATE`/`DELETE`. Um invasor que comprometa a aplicação não
 * consegue apagar o próprio rastro sem também comprometer as credenciais
 * administrativas do banco.
 */
export const DataAccessAction = {
  /** Leitura de campos cifrados em claro. */
  READ_SENSITIVE: 'READ_SENSITIVE',
  READ_MASKED: 'READ_MASKED',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  /** Consulta de elegibilidade pela SAGA — não expõe dado pessoal. */
  ELIGIBILITY_CHECK: 'ELIGIBILITY_CHECK',
  /** Exportação para emissão de cobrança ou documentação do veículo. */
  EXPORT_FOR_BILLING: 'EXPORT_FOR_BILLING',
  EXPORT_FOR_DOCUMENTATION: 'EXPORT_FOR_DOCUMENTATION',
  /** Portabilidade: art. 18, V. */
  DATA_SUBJECT_EXPORT: 'DATA_SUBJECT_EXPORT',
  /** Eliminação: art. 18, VI. */
  ANONYMIZE: 'ANONYMIZE',
  CONSENT_CHANGE: 'CONSENT_CHANGE',
} as const;
export type DataAccessAction = (typeof DataAccessAction)[keyof typeof DataAccessAction];

export const AccessOutcome = {
  ALLOWED: 'ALLOWED',
  DENIED: 'DENIED',
} as const;
export type AccessOutcome = (typeof AccessOutcome)[keyof typeof AccessOutcome];

export interface DataAccessLogProps {
  id: string;
  customerId: string;
  /** `sub` do token de quem acessou — pessoa ou serviço. */
  actorId: string;
  actorType: 'USER' | 'SERVICE';
  actorRoles: string[];
  action: DataAccessAction;
  /**
   * Finalidade declarada na requisição. Sem ela a requisição é recusada:
   * é o que permite auditar se o acesso respeitou o princípio da finalidade.
   */
  purpose: string;
  /** Quais campos foram efetivamente devolvidos em claro. */
  fieldsAccessed: string[];
  outcome: AccessOutcome;
  denialReason: string | null;
  correlationId: string;
  sourceIp: string | null;
  userAgent: string | null;
  occurredAt: Date;
}

export class DataAccessLog {
  private constructor(readonly props: DataAccessLogProps) {}

  static record(props: DataAccessLogProps): DataAccessLog {
    return new DataAccessLog({ ...props });
  }

  toJSON(): DataAccessLogProps {
    return { ...this.props };
  }
}
