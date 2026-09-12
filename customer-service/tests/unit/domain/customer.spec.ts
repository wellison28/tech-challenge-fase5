import { describe, expect, it } from 'vitest';
import { ConsentPurpose } from '../../../src/domain/entities/consent';
import { Customer, CustomerStatus } from '../../../src/domain/entities/customer';
import {
  DataProtectionError,
  ValidationError,
} from '../../../src/domain/errors/domain-error';
import { Cpf } from '../../../src/domain/value-objects/cpf';
import { VALID_CPF } from '../../support/fakes';

const NOW = new Date('2026-01-15T10:00:00.000Z');

function buildCustomer(overrides: Partial<Parameters<typeof Customer.create>[0]> = {}): Customer {
  return Customer.create({
    id: '11111111-1111-4111-8111-111111111111',
    fullName: 'Maria Aparecida da Silva',
    cpf: VALID_CPF,
    birthDate: new Date('1990-05-20T00:00:00.000Z'),
    email: 'maria.silva@exemplo.com.br',
    phone: '11987654321',
    address: {
      zipCode: '01310-100',
      street: 'Avenida Paulista',
      number: '1578',
      complement: 'Conjunto 42',
      district: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    },
    identityDocument: { type: 'RG', number: '123456789', issuer: 'SSP-SP' },
    policyVersion: '2026-01',
    consentSource: 'WEB_FORM',
    now: NOW,
    ...overrides,
  });
}

describe('Cpf', () => {
  it('aceita CPF com dígitos verificadores corretos', () => {
    expect(Cpf.create('529.982.247-25').value).toBe('52998224725');
  });

  it('recusa dígitos verificadores errados', () => {
    expect(() => Cpf.create('52998224726')).toThrow(ValidationError);
  });

  it('recusa sequência repetida', () => {
    expect(() => Cpf.create('11111111111')).toThrow(ValidationError);
  });

  it('recusa quantidade errada de dígitos', () => {
    expect(() => Cpf.create('1234567890')).toThrow(ValidationError);
  });

  it('mascara preservando apenas os últimos cinco dígitos', () => {
    expect(Cpf.create(VALID_CPF).mask()).toBe('***.***.247-25');
  });

  it('a máscara não permite reconstruir o número', () => {
    expect(Cpf.create(VALID_CPF).mask()).not.toContain('529');
  });
});

describe('Customer — criação', () => {
  it('nasce pendente de verificação', () => {
    expect(buildCustomer().status).toBe(CustomerStatus.PENDING_VERIFICATION);
  });

  it('registra automaticamente as finalidades essenciais', () => {
    const customer = buildCustomer();
    expect(customer.hasActiveConsent(ConsentPurpose.PURCHASE_PROCESSING)).toBe(true);
    expect(customer.hasActiveConsent(ConsentPurpose.DOCUMENT_ISSUANCE)).toBe(true);
    expect(customer.hasActiveConsent(ConsentPurpose.MARKETING)).toBe(false);
  });

  it('registra as finalidades opcionais marcadas pelo titular', () => {
    const customer = buildCustomer({ optionalConsents: [ConsentPurpose.MARKETING] });
    expect(customer.hasActiveConsent(ConsentPurpose.MARKETING)).toBe(true);
  });

  it('guarda a versão da política aceita, para demonstrar o consentimento', () => {
    const consent = buildCustomer().consents.find(
      (item) => item.purpose === ConsentPurpose.PURCHASE_PROCESSING,
    );
    expect(consent?.policyVersion).toBe('2026-01');
    expect(consent?.grantedAt).toEqual(NOW);
  });

  it('recusa menor de 18 anos', () => {
    expect(() => buildCustomer({ birthDate: new Date('2015-01-01T00:00:00.000Z') })).toThrow(
      ValidationError,
    );
  });

  it('recusa data de nascimento no futuro', () => {
    expect(() => buildCustomer({ birthDate: new Date('2030-01-01T00:00:00.000Z') })).toThrow(
      ValidationError,
    );
  });

  it('recusa nome sem sobrenome', () => {
    expect(() => buildCustomer({ fullName: 'Maria' })).toThrow(ValidationError);
  });

  it('recusa UF inexistente', () => {
    expect(() =>
      buildCustomer({
        address: {
          zipCode: '01310100', street: 'Rua A', number: '1',
          district: 'Centro', city: 'São Paulo', state: 'XX',
        },
      }),
    ).toThrow(ValidationError);
  });
});

describe('Customer — consentimento', () => {
  it('permite revogar finalidade opcional', () => {
    const customer = buildCustomer({ optionalConsents: [ConsentPurpose.MARKETING] });
    customer.revokeConsent(ConsentPurpose.MARKETING, NOW);

    expect(customer.hasActiveConsent(ConsentPurpose.MARKETING)).toBe(false);
    const consent = customer.consents.find((item) => item.purpose === ConsentPurpose.MARKETING);
    expect(consent?.revokedAt).toEqual(NOW);
  });

  it('recusa revogar finalidade essencial ao contrato', () => {
    const customer = buildCustomer();
    expect(() => customer.revokeConsent(ConsentPurpose.PURCHASE_PROCESSING, NOW)).toThrow(
      ValidationError,
    );
  });

  it('permite reconceder consentimento revogado, com nova versão da política', () => {
    const customer = buildCustomer({ optionalConsents: [ConsentPurpose.MARKETING] });
    customer.revokeConsent(ConsentPurpose.MARKETING, NOW);
    customer.grantConsent(ConsentPurpose.MARKETING, '2026-06', 'WEB_FORM', NOW);

    const consent = customer.consents.find((item) => item.purpose === ConsentPurpose.MARKETING);
    expect(consent?.granted).toBe(true);
    expect(consent?.policyVersion).toBe('2026-06');
    expect(consent?.revokedAt).toBeNull();
  });

  it('recusa revogar finalidade nunca registrada', () => {
    expect(() => buildCustomer().revokeConsent(ConsentPurpose.MARKETING, NOW)).toThrow(
      ValidationError,
    );
  });
});

describe('Customer — elegibilidade para comprar', () => {
  it('cadastro apenas criado ainda não pode comprar', () => {
    const result = buildCustomer().checkPurchaseEligibility(NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('EMAIL_NAO_VERIFICADO');
  });

  it('cadastro ativo e completo pode comprar', () => {
    const customer = buildCustomer();
    customer.activate(NOW);
    expect(customer.checkPurchaseEligibility(NOW)).toEqual({ eligible: true, reasons: [] });
  });

  it('cadastro bloqueado não pode comprar', () => {
    const customer = buildCustomer();
    customer.activate(NOW);
    customer.block(NOW);
    expect(customer.checkPurchaseEligibility(NOW).reasons).toContain('CADASTRO_BLOQUEADO');
  });

  it('cadastro anonimizado não pode comprar', () => {
    const customer = buildCustomer();
    customer.anonymize(NOW);
    expect(customer.checkPurchaseEligibility(NOW).reasons).toContain('CADASTRO_ANONIMIZADO');
  });
});

describe('Customer — anonimização (LGPD art. 18, VI)', () => {
  it('apaga todo dado pessoal preservando o identificador', () => {
    const customer = buildCustomer();
    customer.anonymize(NOW);

    expect(customer.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(customer.fullName).toBeNull();
    expect(customer.cpf).toBeNull();
    expect(customer.birthDate).toBeNull();
    expect(customer.email).toBeNull();
    expect(customer.phone).toBeNull();
    expect(customer.address).toBeNull();
    expect(customer.identityDocument).toBeNull();
    expect(customer.consents).toEqual([]);
    expect(customer.status).toBe(CustomerStatus.ANONYMIZED);
    expect(customer.anonymizedAt).toEqual(NOW);
  });

  it('é idempotente', () => {
    const customer = buildCustomer();
    customer.anonymize(NOW);
    const version = customer.version;

    customer.anonymize(new Date(NOW.getTime() + 1000));
    expect(customer.version).toBe(version);
    expect(customer.anonymizedAt).toEqual(NOW);
  });

  it('bloqueia qualquer alteração posterior de dado pessoal', () => {
    const customer = buildCustomer();
    customer.anonymize(NOW);

    expect(() => customer.updateContact({ phone: '11999999999' }, NOW)).toThrow(DataProtectionError);
    expect(() => customer.activate(NOW)).toThrow(DataProtectionError);
    expect(() =>
      customer.grantConsent(ConsentPurpose.MARKETING, '2026-01', 'WEB_FORM', NOW),
    ).toThrow(DataProtectionError);
  });
});

describe('Customer — mascaramento dos value objects', () => {
  it('e-mail expõe apenas as duas primeiras letras', () => {
    expect(buildCustomer().email?.mask()).toBe('ma*********@exemplo.com.br');
  });

  it('telefone expõe apenas os quatro últimos dígitos', () => {
    expect(buildCustomer().phone?.mask()).toBe('(11) *****-4321');
  });

  it('endereço público traz apenas cidade e UF', () => {
    expect(buildCustomer().address?.toCoarseJSON()).toEqual({ city: 'São Paulo', state: 'SP' });
  });

  it('documento de identidade expõe apenas os três últimos caracteres', () => {
    expect(buildCustomer().identityDocument?.mask().number).toBe('******789');
  });
});
