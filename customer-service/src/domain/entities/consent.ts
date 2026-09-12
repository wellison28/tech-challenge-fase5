import { ValidationError } from '../errors/domain-error';

/**
 * Finalidades de tratamento (LGPD art. 6º, I — princípio da finalidade).
 *
 * Cada finalidade é registrada separadamente porque a base legal de cada uma é
 * diferente, e porque o titular pode revogar uma sem derrubar as outras.
 */
export const ConsentPurpose = {
  /** Execução do contrato de compra e venda (art. 7º, V). Necessário. */
  PURCHASE_PROCESSING: 'PURCHASE_PROCESSING',
  /** Emissão de cobrança e documentação do veículo (art. 7º, II e V). Necessário. */
  DOCUMENT_ISSUANCE: 'DOCUMENT_ISSUANCE',
  /** Comunicações de marketing (art. 7º, I). Opt-in, sempre revogável. */
  MARKETING: 'MARKETING',
  /** Análise de crédito por parceiro financeiro (art. 7º, I). Opt-in. */
  CREDIT_ANALYSIS: 'CREDIT_ANALYSIS',
} as const;
export type ConsentPurpose = (typeof ConsentPurpose)[keyof typeof ConsentPurpose];

/** Finalidades sem as quais a compra não pode acontecer — não são opt-out. */
export const ESSENTIAL_PURPOSES: ConsentPurpose[] = [
  ConsentPurpose.PURCHASE_PROCESSING,
  ConsentPurpose.DOCUMENT_ISSUANCE,
];

export interface ConsentProps {
  purpose: ConsentPurpose;
  granted: boolean;
  /** Versão da política de privacidade aceita — prova o que o titular leu. */
  policyVersion: string;
  grantedAt: Date | null;
  revokedAt: Date | null;
  /** Origem do aceite, para demonstrar a manifestação inequívoca (art. 8º). */
  source: 'WEB_FORM' | 'MOBILE_APP' | 'IN_STORE' | 'MIGRATION';
}

/**
 * Registro de consentimento.
 *
 * A LGPD exige que o controlador **demonstre** o consentimento (art. 8º, §2º).
 * Guardar apenas um booleano não cumpre isso: guardamos quando, para qual
 * finalidade, sob qual versão da política e por qual canal.
 */
export class Consent {
  private constructor(private props: ConsentProps) {}

  static grant(input: {
    purpose: ConsentPurpose;
    policyVersion: string;
    source: ConsentProps['source'];
    now: Date;
  }): Consent {
    if (!input.policyVersion?.trim()) {
      throw new ValidationError('A versão da política de privacidade é obrigatória');
    }
    return new Consent({
      purpose: input.purpose,
      granted: true,
      policyVersion: input.policyVersion,
      grantedAt: input.now,
      revokedAt: null,
      source: input.source,
    });
  }

  static restore(props: ConsentProps): Consent {
    return new Consent({ ...props });
  }

  revoke(now: Date): void {
    if (ESSENTIAL_PURPOSES.includes(this.props.purpose)) {
      throw new ValidationError(
        'Esta finalidade é necessária à execução do contrato e não pode ser revogada ' +
          'isoladamente; solicite a exclusão do cadastro',
        { purpose: this.props.purpose },
      );
    }
    this.props = { ...this.props, granted: false, revokedAt: now };
  }

  regrant(policyVersion: string, source: ConsentProps['source'], now: Date): void {
    this.props = {
      ...this.props,
      granted: true,
      policyVersion,
      grantedAt: now,
      revokedAt: null,
      source,
    };
  }

  get purpose(): ConsentPurpose { return this.props.purpose; }
  get granted(): boolean { return this.props.granted; }
  get policyVersion(): string { return this.props.policyVersion; }
  get grantedAt(): Date | null { return this.props.grantedAt; }
  get revokedAt(): Date | null { return this.props.revokedAt; }
  get source(): ConsentProps['source'] { return this.props.source; }

  toJSON(): ConsentProps {
    return { ...this.props };
  }
}
