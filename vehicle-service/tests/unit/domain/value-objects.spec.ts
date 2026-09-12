import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/domain/errors/domain-error';
import { LicensePlate } from '../../../src/domain/value-objects/license-plate';
import { Money } from '../../../src/domain/value-objects/money';
import { Vin } from '../../../src/domain/value-objects/vin';

describe('Money', () => {
  it('converte reais para centavos sem erro de ponto flutuante', () => {
    // 89990.57 * 100 em ponto flutuante dá 8999056.999999999
    expect(Money.fromDecimal(89_990.57).cents).toBe(8_999_057);
  });

  it('rejeita valor negativo', () => {
    expect(() => Money.fromCents(-1)).toThrow(ValidationError);
  });

  it('rejeita fração de centavo', () => {
    expect(() => Money.fromCents(10.5)).toThrow(ValidationError);
  });

  it('rejeita valor acima do teto de INTEGER do Postgres', () => {
    expect(() => Money.fromCents(2_000_000_001)).toThrow(ValidationError);
  });

  it('formata em real brasileiro', () => {
    // Intl usa espaço não separável (U+00A0) depois do símbolo da moeda.
    expect(Money.fromCents(8_999_000).format().replace(/\u00a0/g, ' ')).toBe('R$ 89.990,00');
  });
});

describe('Vin', () => {
  it('normaliza para maiúsculas', () => {
    expect(Vin.create('9bwzzz377vt004251').value).toBe('9BWZZZ377VT004251');
  });

  it.each(['9BWZZZ377VT00425', 'I9BWZZZ377VT00425', ''])('rejeita %s', (invalid) => {
    expect(() => Vin.create(invalid)).toThrow(ValidationError);
  });
});

describe('LicensePlate', () => {
  it('aceita o padrão antigo', () => {
    expect(LicensePlate.create('abc-1234').value).toBe('ABC1234');
  });

  it('aceita o padrão Mercosul', () => {
    expect(LicensePlate.create('abc1d23').value).toBe('ABC1D23');
  });

  it('rejeita formato inválido', () => {
    expect(() => LicensePlate.create('AB12345')).toThrow(ValidationError);
  });
});
