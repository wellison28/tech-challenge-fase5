import type { Customer as CustomerRow, CustomerConsent as ConsentRow } from '@prisma/client';
import { EncryptedPayload, FieldCipher } from '../../../application/ports/crypto';
import { Consent, ConsentPurpose } from '../../../domain/entities/consent';
import { Customer, CustomerProps, CustomerStatus } from '../../../domain/entities/customer';
import { Address } from '../../../domain/value-objects/address';
import { Cpf } from '../../../domain/value-objects/cpf';
import { Email } from '../../../domain/value-objects/email';
import { IdentityDocument } from '../../../domain/value-objects/identity-document';
import { Phone } from '../../../domain/value-objects/phone';

/** Forma dos dados pessoais dentro do envelope cifrado. */
interface PiiEnvelope {
  fullName: string;
  cpf: string;
  birthDate: string;
  email: string;
  phone: string;
  address: ReturnType<Address['toJSON']>;
  identityDocument: ReturnType<IdentityDocument['toJSON']>;
}

const PII_FIELD = 'pii';

type CustomerRowWithConsents = CustomerRow & { consents: ConsentRow[] };

/**
 * Tradutor entre a linha do banco e o agregado, aplicando cifra e decifra.
 *
 * A criptografia vive aqui, e não nos casos de uso, porque é uma preocupação de
 * persistência: o domínio raciocina sobre CPF, não sobre AES-GCM. Um único
 * envelope por registro (em vez de um por campo) reduz a chamada ao KMS a uma
 * por escrita e uma por leitura — chamar `GenerateDataKey` sete vezes por
 * cadastro multiplicaria custo e latência sem ganho de segurança, já que todos
 * os campos têm a mesma classificação e o mesmo público autorizado.
 */
export class CustomerMapper {
  constructor(private readonly cipher: FieldCipher) {}

  async toDomain(row: CustomerRowWithConsents): Promise<Customer> {
    const consents = new Map<ConsentPurpose, Consent>();
    for (const consent of row.consents) {
      consents.set(
        consent.purpose as ConsentPurpose,
        Consent.restore({
          purpose: consent.purpose as ConsentPurpose,
          granted: consent.granted,
          policyVersion: consent.policyVersion,
          grantedAt: consent.grantedAt,
          revokedAt: consent.revokedAt,
          source: consent.source as 'WEB_FORM' | 'MOBILE_APP' | 'IN_STORE' | 'MIGRATION',
        }),
      );
    }

    const base: Omit<
      CustomerProps,
      'fullName' | 'cpf' | 'birthDate' | 'email' | 'phone' | 'address' | 'identityDocument'
    > = {
      id: row.id,
      status: row.status as CustomerStatus,
      consents,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      anonymizedAt: row.anonymizedAt,
    };

    const envelope = CustomerMapper.readEnvelope(row);
    if (!envelope) {
      // Cadastro anonimizado: não há o que decifrar.
      return Customer.restore({
        ...base,
        fullName: null,
        cpf: null,
        birthDate: null,
        email: null,
        phone: null,
        address: null,
        identityDocument: null,
      });
    }

    const plaintext = await this.cipher.decrypt(envelope, {
      customerId: row.id,
      field: PII_FIELD,
    });
    const pii = JSON.parse(plaintext) as PiiEnvelope;

    return Customer.restore({
      ...base,
      fullName: pii.fullName,
      cpf: Cpf.create(pii.cpf),
      birthDate: new Date(pii.birthDate),
      email: Email.create(pii.email),
      phone: Phone.create(pii.phone),
      address: Address.create(pii.address),
      identityDocument: IdentityDocument.create(pii.identityDocument),
    });
  }

  async toPersistence(customer: Customer): Promise<{
    scalars: Record<string, unknown>;
    consents: Array<{
      purpose: ConsentPurpose;
      granted: boolean;
      policyVersion: string;
      grantedAt: Date | null;
      revokedAt: Date | null;
      source: string;
    }>;
  }> {
    const encrypted = await this.encryptPii(customer);

    return {
      scalars: {
        id: customer.id,
        status: customer.status,
        version: customer.version,
        piiCiphertext: encrypted?.ciphertext ?? null,
        piiEncryptedDataKey: encrypted?.encryptedDataKey ?? null,
        piiIv: encrypted?.iv ?? null,
        piiAuthTag: encrypted?.authTag ?? null,
        piiKeyId: encrypted?.keyId ?? null,
        piiAlgorithm: encrypted?.algorithm ?? null,
        piiSchemaVersion: encrypted?.schemaVersion ?? null,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
        anonymizedAt: customer.anonymizedAt,
      },
      consents: customer.consents.map((consent) => ({
        purpose: consent.purpose,
        granted: consent.granted,
        policyVersion: consent.policyVersion,
        grantedAt: consent.grantedAt,
        revokedAt: consent.revokedAt,
        source: consent.source,
      })),
    };
  }

  private async encryptPii(customer: Customer): Promise<EncryptedPayload | null> {
    if (
      !customer.cpf ||
      !customer.email ||
      !customer.phone ||
      !customer.address ||
      !customer.identityDocument ||
      !customer.fullName ||
      !customer.birthDate
    ) {
      return null;
    }

    const envelope: PiiEnvelope = {
      fullName: customer.fullName,
      cpf: customer.cpf.value,
      birthDate: customer.birthDate.toISOString(),
      email: customer.email.value,
      phone: customer.phone.digits,
      address: customer.address.toJSON(),
      identityDocument: customer.identityDocument.toJSON(),
    };

    return this.cipher.encrypt(JSON.stringify(envelope), {
      customerId: customer.id,
      field: PII_FIELD,
    });
  }

  private static readEnvelope(row: CustomerRow): EncryptedPayload | null {
    if (
      !row.piiCiphertext ||
      !row.piiEncryptedDataKey ||
      !row.piiIv ||
      !row.piiAuthTag ||
      !row.piiKeyId
    ) {
      return null;
    }
    return {
      ciphertext: row.piiCiphertext,
      encryptedDataKey: row.piiEncryptedDataKey,
      iv: row.piiIv,
      authTag: row.piiAuthTag,
      keyId: row.piiKeyId,
      algorithm: 'AES-256-GCM',
      schemaVersion: row.piiSchemaVersion ?? 1,
    };
  }
}
