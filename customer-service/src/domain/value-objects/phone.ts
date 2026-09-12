import { ValidationError } from '../errors/domain-error';

/** Celular brasileiro: DDD (2) + 9 dígitos, ou fixo com 8. */
const BR_PHONE_PATTERN = /^\d{2}9?\d{8}$/;

export class Phone {
  private constructor(readonly digits: string) {}

  static create(raw: string): Phone {
    const digits = (raw ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');

    if (!BR_PHONE_PATTERN.test(digits)) {
      throw new ValidationError(
        'Telefone inválido: informe DDD + número (ex.: 11987654321)',
      );
    }
    return new Phone(digits);
  }

  format(): string {
    const ddd = this.digits.slice(0, 2);
    const rest = this.digits.slice(2);
    const middle = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
    return `(${ddd}) ${middle}-${rest.slice(middle.length)}`;
  }

  mask(): string {
    return `(${this.digits.slice(0, 2)}) *****-${this.digits.slice(-4)}`;
  }
}
