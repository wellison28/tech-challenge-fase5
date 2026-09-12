import { ValidationError } from '../errors/domain-error';

/** Padrão antigo (ABC1234) e padrão Mercosul (ABC1D23). */
const LEGACY_PATTERN = /^[A-Z]{3}[0-9]{4}$/;
const MERCOSUL_PATTERN = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;

export class LicensePlate {
  private constructor(readonly value: string) {}

  static create(raw: string): LicensePlate {
    const normalized = raw.trim().toUpperCase().replace(/[\s-]/g, '');
    if (!LEGACY_PATTERN.test(normalized) && !MERCOSUL_PATTERN.test(normalized)) {
      throw new ValidationError(
        'Placa inválida: use o padrão antigo (ABC1234) ou Mercosul (ABC1D23)',
        { licensePlate: raw },
      );
    }
    return new LicensePlate(normalized);
  }

  toString(): string {
    return this.value;
  }
}
