/**
 * Campo cifrado como é persistido.
 *
 * Guardamos a chave de dados **cifrada** junto do texto cifrado (envelope
 * encryption): quem obtiver um dump do banco não tem como decifrar nada sem
 * permissão de `kms:Decrypt` na chave mestra, que vive fora do banco.
 */
export interface EncryptedPayload {
  /** Texto cifrado em base64. */
  ciphertext: string;
  /** Chave de dados AES-256 cifrada pela chave mestra (KMS), em base64. */
  encryptedDataKey: string;
  /** Vetor de inicialização — único por operação. */
  iv: string;
  /** Tag de autenticação do GCM: detecta adulteração do texto cifrado. */
  authTag: string;
  keyId: string;
  algorithm: 'AES-256-GCM';
  /** Versão do esquema de cifra, para permitir rotação/migração sem downtime. */
  schemaVersion: number;
}

/**
 * Dados adicionais autenticados (AAD).
 *
 * Amarram o texto cifrado ao registro e ao campo de origem. Sem isso, um
 * atacante com acesso de escrita ao banco poderia mover o CPF cifrado de um
 * titular para a linha de outro e a decifragem funcionaria normalmente. Com
 * AAD, a verificação do GCM falha.
 */
export interface EncryptionContext {
  customerId: string;
  field: string;
}

export interface FieldCipher {
  encrypt(plaintext: string, context: EncryptionContext): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload, context: EncryptionContext): Promise<string>;
}

/**
 * Índice cego (blind index).
 *
 * Cifra autenticada é não determinística — dois CPFs iguais geram textos
 * cifrados diferentes, o que impede `WHERE cpf = ?`. O índice cego resolve
 * isso guardando um HMAC do valor normalizado: permite busca exata e restrição
 * de unicidade sem armazenar nem decifrar o dado.
 *
 * Usa HMAC com *pepper* guardado no Secrets Manager (não no banco). Um dump do
 * banco, sozinho, não permite o ataque de dicionário que um SHA-256 simples
 * sofreria — o espaço de CPFs válidos tem menos de 10¹¹ elementos e seria
 * varrido em minutos.
 */
export interface BlindIndex {
  compute(value: string): Promise<string>;
}
