import { ValidationError } from '../errors/domain-error';

/**
 * Teto de R$ 20.000.000,00. Escolhido para caber em INTEGER (4 bytes) do
 * PostgreSQL: evita BigInt no ORM e na serialização JSON sem restringir nenhum
 * preço praticável de veículo.
 */
const MAX_AMOUNT_IN_CENTS = 2_000_000_000;

/**
 * Valor monetário representado em centavos (inteiro).
 *
 * Motivo: ponto flutuante (`number`/`double`) não representa valores decimais
 * de base 10 com exatidão, o que produz erro de arredondamento em somas de preço.
 * Todo o serviço persiste e trafega centavos; a conversão para reais acontece
 * apenas na serialização de saída.
 */
export class Money {
  private constructor(readonly cents: number) {}

  static fromCents(cents: number): Money {
    if (!Number.isInteger(cents)) {
      throw new ValidationError('O valor em centavos deve ser um número inteiro', { cents });
    }
    if (cents < 0) {
      throw new ValidationError('O valor monetário não pode ser negativo', { cents });
    }
    if (cents > MAX_AMOUNT_IN_CENTS) {
      throw new ValidationError('O valor monetário excede o limite permitido', { cents });
    }
    return new Money(cents);
  }

  /** Aceita reais com até duas casas decimais (ex.: 89990.5) e converte para centavos. */
  static fromDecimal(amount: number): Money {
    if (!Number.isFinite(amount)) {
      throw new ValidationError('O valor monetário deve ser um número finito', { amount });
    }
    return Money.fromCents(Math.round(amount * 100));
  }

  toDecimal(): number {
    return this.cents / 100;
  }

  format(locale = 'pt-BR', currency = 'BRL'): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(this.toDecimal());
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }
}
