import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { LocalFieldCipher } from '../src/infrastructure/crypto/local-field-cipher';
import { HmacBlindIndex } from '../src/infrastructure/crypto/hmac-blind-index';

/**
 * Massa de dados para desenvolvimento.
 *
 * Usa a mesma cifra e o mesmo índice cego da aplicação: assim o dado semeado é
 * legível pelo serviço e o banco local não contém CPF em claro nem em ambiente
 * de desenvolvimento — o hábito é o controle.
 */
const prisma = new PrismaClient();

const MASTER_KEY = process.env.LOCAL_MASTER_KEY ?? 'bG9jYWwtZGV2LW1hc3Rlci1rZXktMzItYnl0ZXMtISE=';
const PEPPER = process.env.CPF_BLIND_INDEX_PEPPER ?? 'dev-only-pepper-change-me';
const POLICY_VERSION = process.env.PRIVACY_POLICY_VERSION ?? '2026-01';

const cipher = new LocalFieldCipher(MASTER_KEY);
const blindIndex = new HmacBlindIndex(PEPPER);

const people = [
  {
    fullName: 'Maria Aparecida da Silva',
    cpf: '52998224725',
    birthDate: '1990-05-20',
    email: 'maria.silva@exemplo.com.br',
    phone: '11987654321',
    address: { zipCode: '01310100', street: 'Avenida Paulista', number: '1578', complement: 'Conj. 42', district: 'Bela Vista', city: 'São Paulo', state: 'SP' },
    identityDocument: { type: 'RG', number: '123456789', issuer: 'SSP-SP' },
    status: 'ACTIVE' as const,
  },
  {
    fullName: 'João Carlos Pereira',
    cpf: '11144477735',
    birthDate: '1985-11-03',
    email: 'joao.pereira@exemplo.com.br',
    phone: '21998877665',
    address: { zipCode: '22071900', street: 'Avenida Atlântica', number: '1702', complement: null, district: 'Copacabana', city: 'Rio de Janeiro', state: 'RJ' },
    identityDocument: { type: 'CNH', number: '98765432100', issuer: 'DETRAN-RJ' },
    status: 'ACTIVE' as const,
  },
  {
    fullName: 'Ana Beatriz Nogueira',
    cpf: '39053344705',
    birthDate: '1998-02-14',
    email: 'ana.nogueira@exemplo.com.br',
    phone: '31991234567',
    address: { zipCode: '30130010', street: 'Avenida Afonso Pena', number: '1212', complement: 'Apto 801', district: 'Centro', city: 'Belo Horizonte', state: 'MG' },
    identityDocument: { type: 'RG', number: 'MG1234567', issuer: 'SSP-MG' },
    status: 'PENDING_VERIFICATION' as const,
  },
];

async function main(): Promise<void> {
  await prisma.dataAccessLog.deleteMany();
  await prisma.customerConsent.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.customer.deleteMany();

  const now = new Date();

  for (const person of people) {
    const id = randomUUID();
    const envelope = await cipher.encrypt(
      JSON.stringify({
        fullName: person.fullName,
        cpf: person.cpf,
        birthDate: new Date(`${person.birthDate}T00:00:00.000Z`).toISOString(),
        email: person.email,
        phone: person.phone,
        address: person.address,
        identityDocument: person.identityDocument,
      }),
      { customerId: id, field: 'pii' },
    );

    await prisma.customer.create({
      data: {
        id,
        status: person.status,
        version: 1,
        cpfBlindIndex: await blindIndex.compute(person.cpf),
        emailBlindIndex: await blindIndex.compute(person.email),
        blindIndexVersion: 1,
        piiCiphertext: envelope.ciphertext,
        piiEncryptedDataKey: envelope.encryptedDataKey,
        piiIv: envelope.iv,
        piiAuthTag: envelope.authTag,
        piiKeyId: envelope.keyId,
        piiAlgorithm: envelope.algorithm,
        piiSchemaVersion: envelope.schemaVersion,
        createdAt: now,
        updatedAt: now,
        consents: {
          create: [
            { purpose: 'PURCHASE_PROCESSING', granted: true, policyVersion: POLICY_VERSION, grantedAt: now, source: 'WEB_FORM' },
            { purpose: 'DOCUMENT_ISSUANCE', granted: true, policyVersion: POLICY_VERSION, grantedAt: now, source: 'WEB_FORM' },
          ],
        },
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seed concluído: ${people.length} cliente(s), com dados pessoais cifrados.`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
