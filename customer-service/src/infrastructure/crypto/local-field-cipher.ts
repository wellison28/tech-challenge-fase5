import { hkdfSync, randomBytes } from 'node:crypto';
import {
  EncryptedPayload,
  EncryptionContext,
  FieldCipher,
} from '../../application/ports/crypto';
import { KEY_LENGTH_BYTES, decryptAesGcm, encryptAesGcm } from './aes-gcm';

const SCHEMA_VERSION = 1;

/**
 * Substituto do KMS para desenvolvimento e testes.
 *
 * Mantém exatamente a mesma forma de dado (`EncryptedPayload`) e o mesmo AAD,
 * para que o código de aplicação não perceba diferença — o que muda é apenas
 * de onde vem a chave mestra. A chave de dados é derivada por HKDF a partir de
 * um salt aleatório, que faz o papel do `CiphertextBlob` do KMS.
 *
 * Nunca deve ser usado em produção: `loadEnv` recusa `CRYPTO_MODE=local`
 * quando `NODE_ENV=production`.
 */
export class LocalFieldCipher implements FieldCipher {
  private readonly masterKey: Buffer;

  constructor(masterKeyBase64: string) {
    this.masterKey = Buffer.from(masterKeyBase64, 'base64');
    if (this.masterKey.length < 16) {
      throw new Error('LOCAL_MASTER_KEY deve ter ao menos 16 bytes em base64');
    }
  }

  async encrypt(plaintext: string, context: EncryptionContext): Promise<EncryptedPayload> {
    const salt = randomBytes(16);
    const key = this.deriveKey(salt, context);
    const { ciphertext, iv, authTag } = encryptAesGcm(plaintext, key, LocalFieldCipher.toAad(context));

    return {
      ciphertext: ciphertext.toString('base64'),
      encryptedDataKey: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyId: 'local-dev-key',
      algorithm: 'AES-256-GCM',
      schemaVersion: SCHEMA_VERSION,
    };
  }

  async decrypt(payload: EncryptedPayload, context: EncryptionContext): Promise<string> {
    const key = this.deriveKey(Buffer.from(payload.encryptedDataKey, 'base64'), context);

    return decryptAesGcm(
      {
        ciphertext: Buffer.from(payload.ciphertext, 'base64'),
        iv: Buffer.from(payload.iv, 'base64'),
        authTag: Buffer.from(payload.authTag, 'base64'),
      },
      key,
      LocalFieldCipher.toAad(context),
    );
  }

  private deriveKey(salt: Buffer, context: EncryptionContext): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        this.masterKey,
        salt,
        Buffer.from(`${context.customerId}:${context.field}`, 'utf8'),
        KEY_LENGTH_BYTES,
      ),
    );
  }

  private static toAad(context: EncryptionContext): Buffer {
    return Buffer.from(`${context.customerId}:${context.field}`, 'utf8');
  }
}
