import { ValidationError } from '../errors/domain-error';

/**
 * CPF — dado pessoal e identificador fiscal do comprador.
 *
 * É indispensável ao negócio: entra no código de pagamento (boleto/Pix exigem o
 * CPF do pagador) e na documentação de transferência do veículo. Por isso é
 * coletado, mas nunca armazenado em claro — ver `EncryptedField` e o índice cego.
 *
 * O valor circula em memória apenas durante a requisição que precisa dele.
 */
export class Cpf {
  private constructor(private readonly digits: string) {}

  static create(raw: string): Cpf {
    const digits = (raw ?? '').replace(/\D/g, '');

    if (digits.length !== 11) {
      throw new ValidationError('CPF deve conter 11 dígitos');
    }
    // Sequências repetidas (000..., 111...) passam no cálculo dos dígitos
    // verificadores, mas não são CPFs válidos.
    if (/^(\d)\1{10}$/.test(digits)) {
      throw new ValidationError('CPF inválido');
    }
    if (!Cpf.hasValidCheckDigits(digits)) {
      throw new ValidationError('CPF inválido: dígitos verificadores não conferem');
    }

    return new Cpf(digits);
  }

  static isValid(raw: string): boolean {
    try {
      Cpf.create(raw);
      return true;
    } catch {
      return false;
    }
  }

  /** Forma canônica, só dígitos. É esta que alimenta a cifra e o índice cego. */
  get value(): string {
    return this.digits;
  }

  format(): string {
    return this.digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }

  /**
   * Forma exibível por padrão nas respostas da API e nos logs.
   * Mantém só o suficiente para o titular se reconhecer (`***.***.789-01`),
   * sem permitir a reconstrução do número — minimização aplicada na saída.
   */
  mask(): string {
    return `***.***.${this.digits.slice(6, 9)}-${this.digits.slice(9)}`;
  }

  private static hasValidCheckDigits(digits: string): boolean {
    for (const [length, position] of [
      [9, 9],
      [10, 10],
    ] as const) {
      let sum = 0;
      for (let i = 0; i < length; i += 1) {
        sum += Number(digits[i]) * (length + 1 - i);
      }
      const remainder = (sum * 10) % 11;
      const expected = remainder === 10 ? 0 : remainder;
      if (expected !== Number(digits[position])) {
        return false;
      }
    }
    return true;
  }
}
