import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import {
  EncryptedPayload,
  EncryptionContext,
  FieldCipher,
} from '../../application/ports/crypto';
import { decryptAesGcm, encryptAesGcm } from './aes-gcm';

const SCHEMA_VERSION = 1;

/**
 * Criptografia em nível de campo com envelope encryption e AWS KMS.
 *
 * Fluxo de escrita:
 *   1. KMS `GenerateDataKey` devolve a chave AES-256 em claro **e** cifrada;
 *   2. o dado é cifrado localmente com a chave em claro (rápido e barato);
 *   3. grava-se o texto cifrado + a chave cifrada; a chave em claro é descartada.
 *
 * Por que não `kms:Encrypt` direto: a API do KMS aceita no máximo 4 KB por
 * chamada, cobra por requisição e adiciona latência de rede a cada campo. Com
 * envelope encryption, o KMS é acionado uma vez por operação de escrita e a
 * cifra em si acontece em memória.
 *
 * O `EncryptionContext` do KMS reproduz o AAD: mesmo com permissão de
 * `kms:Decrypt`, a chave de dados só é aberta apresentando o mesmo contexto
 * (`customerId` + campo), o que fica registrado no CloudTrail.
 */
export class KmsFieldCipher implements FieldCipher {
  private readonly client: KMSClient;

  constructor(
    private readonly keyId: string,
    options: { region: string; endpoint?: string },
  ) {
    this.client = new KMSClient({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
  }

  async encrypt(plaintext: string, context: EncryptionContext): Promise<EncryptedPayload> {
    const kmsContext = KmsFieldCipher.toKmsContext(context);

    const dataKey = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: kmsContext,
      }),
    );

    if (!dataKey.Plaintext || !dataKey.CiphertextBlob) {
      throw new Error('KMS não devolveu a chave de dados');
    }

    const key = Buffer.from(dataKey.Plaintext);
    try {
      const { ciphertext, iv, authTag } = encryptAesGcm(
        plaintext,
        key,
        KmsFieldCipher.toAad(context),
      );

      return {
        ciphertext: ciphertext.toString('base64'),
        encryptedDataKey: Buffer.from(dataKey.CiphertextBlob).toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        keyId: dataKey.KeyId ?? this.keyId,
        algorithm: 'AES-256-GCM',
        schemaVersion: SCHEMA_VERSION,
      };
    } finally {
      // Sobrescreve a chave em claro na memória assim que ela deixa de ser
      // necessária, encurtando a janela em que apareceria num core dump.
      key.fill(0);
    }
  }

  async decrypt(payload: EncryptedPayload, context: EncryptionContext): Promise<string> {
    const decrypted = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(payload.encryptedDataKey, 'base64'),
        EncryptionContext: KmsFieldCipher.toKmsContext(context),
      }),
    );

    if (!decrypted.Plaintext) {
      throw new Error('KMS não conseguiu abrir a chave de dados');
    }

    const key = Buffer.from(decrypted.Plaintext);
    try {
      return decryptAesGcm(
        {
          ciphertext: Buffer.from(payload.ciphertext, 'base64'),
          iv: Buffer.from(payload.iv, 'base64'),
          authTag: Buffer.from(payload.authTag, 'base64'),
        },
        key,
        KmsFieldCipher.toAad(context),
      );
    } finally {
      key.fill(0);
    }
  }

  private static toKmsContext(context: EncryptionContext): Record<string, string> {
    return { customerId: context.customerId, field: context.field, service: 'customer-service' };
  }

  private static toAad(context: EncryptionContext): Buffer {
    return Buffer.from(`${context.customerId}:${context.field}`, 'utf8');
  }
}
