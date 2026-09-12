import { createHmac } from 'node:crypto';
import { BlindIndex } from '../../application/ports/crypto';

/**
 * Índice cego por HMAC-SHA256.
 *
 * O *pepper* não fica no banco: em produção vem do Secrets Manager, carregado
 * na inicialização da Lambda. Assim, um vazamento do dump do banco não permite
 * testar CPFs candidatos contra os hashes — o atacante precisaria também da
 * permissão `secretsmanager:GetSecretValue`, que é concedida a um único papel.
 *
 * Rotação: `pepperVersion` é gravado junto do hash. Ao girar o pepper, os
 * registros antigos continuam consultáveis pela versão anterior enquanto o
 * processo de reindexação avança — sem janela de indisponibilidade.
 */
export class HmacBlindIndex implements BlindIndex {
  constructor(
    private readonly pepper: string,
    readonly pepperVersion = 1,
  ) {
    if (!pepper || pepper.length < 16) {
      throw new Error('O pepper do índice cego deve ter ao menos 16 caracteres');
    }
  }

  async compute(value: string): Promise<string> {
    // Normaliza antes de calcular: "123.456.789-01" e "12345678901" precisam
    // produzir o mesmo índice, ou a restrição de unicidade não funcionaria.
    const normalized = value.replace(/\D/g, '');
    return createHmac('sha256', this.pepper).update(normalized).digest('hex');
  }
}
