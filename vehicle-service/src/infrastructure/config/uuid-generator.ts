import { randomUUID } from 'node:crypto';
import { IdGenerator } from '../../application/ports/id-generator';

/**
 * UUID v4 do módulo nativo `node:crypto` (CSPRNG). Identificadores
 * sequenciais expostos em URL permitiriam enumerar o estoque e inferir volume
 * de vendas da revenda.
 */
export class UuidGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
