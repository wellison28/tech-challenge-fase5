import { ValidationError } from '../errors/domain-error';

const UF_LIST = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB',
  'PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
] as const;
export type Uf = (typeof UF_LIST)[number];

export interface AddressProps {
  zipCode: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  state: Uf;
}

/**
 * Endereço completo do comprador.
 *
 * Coletado porque é exigido na emissão da documentação de transferência do
 * veículo (CRV/ATPV-e) e no cadastro do pagador. É dado pessoal: armazenado
 * cifrado e devolvido pela API apenas de forma reduzida (cidade/UF), salvo
 * requisição autorizada e auditada.
 */
export class Address {
  private constructor(private readonly props: AddressProps) {}

  static create(input: {
    zipCode: string;
    street: string;
    number: string;
    complement?: string | null;
    district: string;
    city: string;
    state: string;
  }): Address {
    const zipCode = (input.zipCode ?? '').replace(/\D/g, '');
    if (zipCode.length !== 8) {
      throw new ValidationError('CEP deve conter 8 dígitos');
    }

    const state = (input.state ?? '').trim().toUpperCase();
    if (!UF_LIST.includes(state as Uf)) {
      throw new ValidationError('UF inválida', { state: input.state });
    }

    return new Address({
      zipCode,
      street: Address.required(input.street, 'logradouro', 150),
      number: Address.required(input.number, 'número', 20),
      complement: input.complement?.trim() || null,
      district: Address.required(input.district, 'bairro', 100),
      city: Address.required(input.city, 'cidade', 100),
      state: state as Uf,
    });
  }

  get zipCode(): string { return this.props.zipCode; }
  get street(): string { return this.props.street; }
  get number(): string { return this.props.number; }
  get complement(): string | null { return this.props.complement; }
  get district(): string { return this.props.district; }
  get city(): string { return this.props.city; }
  get state(): Uf { return this.props.state; }

  toJSON(): AddressProps {
    return { ...this.props };
  }

  /** Versão pública: localidade sem identificar a residência do titular. */
  toCoarseJSON(): { city: string; state: Uf } {
    return { city: this.props.city, state: this.props.state };
  }

  formatZipCode(): string {
    return this.props.zipCode.replace(/(\d{5})(\d{3})/, '$1-$2');
  }

  private static required(value: string, field: string, maxLength: number): string {
    const normalized = (value ?? '').trim();
    if (normalized.length === 0) {
      throw new ValidationError(`O campo "${field}" é obrigatório no endereço`, { field });
    }
    if (normalized.length > maxLength) {
      throw new ValidationError(`O campo "${field}" excede ${maxLength} caracteres`, { field });
    }
    return normalized;
  }
}
