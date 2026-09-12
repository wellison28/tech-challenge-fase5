import { ValidationError } from '../errors/domain-error';

export const IdentityDocumentType = {
  RG: 'RG',
  CNH: 'CNH',
} as const;
export type IdentityDocumentType = (typeof IdentityDocumentType)[keyof typeof IdentityDocumentType];

export interface IdentityDocumentProps {
  type: IdentityDocumentType;
  number: string;
  issuer: string;
}

/**
 * Documento de identidade do comprador.
 *
 * Exigido na emissão do ATPV-e (transferência de propriedade do veículo).
 * É dado pessoal, cifrado em repouso e mascarado por padrão na saída.
 */
export class IdentityDocument {
  private constructor(private readonly props: IdentityDocumentProps) {}

  static create(input: { type: string; number: string; issuer: string }): IdentityDocument {
    const type = (input.type ?? '').trim().toUpperCase();
    if (type !== IdentityDocumentType.RG && type !== IdentityDocumentType.CNH) {
      throw new ValidationError('Tipo de documento deve ser RG ou CNH', { type: input.type });
    }

    const number = (input.number ?? '').replace(/[^\w]/g, '').toUpperCase();
    if (number.length < 5 || number.length > 20) {
      throw new ValidationError('Número do documento deve ter entre 5 e 20 caracteres');
    }

    const issuer = (input.issuer ?? '').trim().toUpperCase();
    if (issuer.length < 2 || issuer.length > 20) {
      throw new ValidationError('Órgão emissor inválido');
    }

    return new IdentityDocument({ type: type as IdentityDocumentType, number, issuer });
  }

  get type(): IdentityDocumentType { return this.props.type; }
  get number(): string { return this.props.number; }
  get issuer(): string { return this.props.issuer; }

  toJSON(): IdentityDocumentProps {
    return { ...this.props };
  }

  mask(): { type: IdentityDocumentType; number: string; issuer: string } {
    return {
      type: this.props.type,
      number: `${'*'.repeat(Math.max(0, this.props.number.length - 3))}${this.props.number.slice(-3)}`,
      issuer: this.props.issuer,
    };
  }
}
