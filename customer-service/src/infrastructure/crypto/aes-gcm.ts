import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const ALGORITHM = 'aes-256-gcm' as const;
export const IV_LENGTH_BYTES = 12; // recomendado pelo NIST SP 800-38D para GCM
export const KEY_LENGTH_BYTES = 32;
export const AUTH_TAG_LENGTH_BYTES = 16;

export interface AesGcmResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * AES-256-GCM: cifra autenticada (AEAD).
 *
 * GCM e não CBC porque GCM entrega confidencialidade **e** integridade na mesma
 * operação: adulterar um byte do texto cifrado faz a decifragem falhar, em vez
 * de produzir lixo silenciosamente.
 */
export function encryptAesGcm(plaintext: string, key: Buffer, aad: Buffer): AesGcmResult {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`A chave AES deve ter ${KEY_LENGTH_BYTES} bytes`);
  }

  // IV aleatório por operação: reutilizar IV em GCM quebra a cifra por completo.
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptAesGcm(
  params: { ciphertext: Buffer; iv: Buffer; authTag: Buffer },
  key: Buffer,
  aad: Buffer,
): string {
  const decipher = createDecipheriv(ALGORITHM, key, params.iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(params.authTag);

  return Buffer.concat([decipher.update(params.ciphertext), decipher.final()]).toString('utf8');
}

/** Comparação em tempo constante: evita vazar informação por temporização. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
