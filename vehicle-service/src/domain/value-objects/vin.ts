import { ValidationError } from '../errors/domain-error';

/** Caracteres I, O e Q não existem em VIN para evitar confusão com 1 e 0. */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * VIN (Vehicle Identification Number) — o chassi.
 *
 * É a chave natural do veículo no mundo real: identifica a unidade física e
 * impede o cadastro duplicado do mesmo carro. Diferente da placa, não muda de
 * valor ao longo da vida do veículo.
 */
export class Vin {
  private constructor(readonly value: string) {}

  static create(raw: string): Vin {
    const normalized = raw.trim().toUpperCase();
    if (!VIN_PATTERN.test(normalized)) {
      throw new ValidationError(
        'Chassi (VIN) inválido: são esperados 17 caracteres alfanuméricos, sem as letras I, O e Q',
        { vin: raw },
      );
    }
    return new Vin(normalized);
  }

  toString(): string {
    return this.value;
  }
}
