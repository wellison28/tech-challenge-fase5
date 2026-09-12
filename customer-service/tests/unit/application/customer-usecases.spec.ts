import { beforeEach, describe, expect, it } from 'vitest';
import { AuditRecorder } from '../../../src/application/audit/audit-recorder';
import { EventFactory } from '../../../src/application/events/event-factory';
import { AccessContext } from '../../../src/application/ports/access-context';
import { AnonymizeCustomerUseCase } from '../../../src/application/usecases/anonymize-customer';
import { ChangeCustomerStatusUseCase } from '../../../src/application/usecases/change-customer-status';
import { CheckPurchaseEligibilityUseCase } from '../../../src/application/usecases/check-purchase-eligibility';
import { ExportPersonalDataUseCase } from '../../../src/application/usecases/export-personal-data';
import { GetCustomerUseCase } from '../../../src/application/usecases/get-customer';
import { ManageConsentUseCase } from '../../../src/application/usecases/manage-consent';
import { RegisterCustomerUseCase } from '../../../src/application/usecases/register-customer';
import { UpdateCustomerUseCase } from '../../../src/application/usecases/update-customer';
import { ConsentPurpose } from '../../../src/domain/entities/consent';
import { DataAccessAction } from '../../../src/domain/entities/data-access-log';
import {
  DataProtectionError,
  DuplicateResourceError,
  NotFoundError,
} from '../../../src/domain/errors/domain-error';
import { CustomerEventType } from '../../../src/domain/events/domain-event';
import { FakeClock, SequentialIdGenerator, VALID_CPF, VALID_CPF_2 } from '../../support/fakes';
import { InMemoryUnitOfWork } from '../../support/in-memory-unit-of-work';

const POLICY_VERSION = '2026-01';

const userContext: AccessContext = {
  actorId: 'operador-1',
  actorType: 'USER',
  actorRoles: ['admin'],
  purpose: 'ATENDIMENTO',
  correlationId: 'corr-1',
  sourceIp: '203.0.113.10',
  userAgent: 'vitest',
};

const sagaContext: AccessContext = {
  actorId: 'sales-service',
  actorType: 'SERVICE',
  actorRoles: [],
  purpose: 'PURCHASE_SAGA',
  correlationId: 'corr-saga',
};

function setup() {
  const uow = new InMemoryUnitOfWork();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator();
  const events = new EventFactory(ids, clock);
  const audit = new AuditRecorder(ids, clock);

  return {
    uow,
    clock,
    register: new RegisterCustomerUseCase(uow, ids, clock, events, audit, POLICY_VERSION),
    get: new GetCustomerUseCase(uow, audit),
    update: new UpdateCustomerUseCase(uow, clock, events, audit),
    status: new ChangeCustomerStatusUseCase(uow, clock, events, audit),
    consent: new ManageConsentUseCase(uow, clock, events, audit, POLICY_VERSION),
    anonymize: new AnonymizeCustomerUseCase(uow, clock, events, audit),
    eligibility: new CheckPurchaseEligibilityUseCase(uow, clock, audit),
    export: new ExportPersonalDataUseCase(uow, clock, audit),
  };
}

function registrationPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Maria Aparecida da Silva',
    cpf: VALID_CPF,
    birthDate: '1990-05-20',
    email: 'maria.silva@exemplo.com.br',
    phone: '11987654321',
    address: {
      zipCode: '01310100',
      street: 'Avenida Paulista',
      number: '1578',
      district: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    },
    identityDocument: { type: 'RG', number: '123456789', issuer: 'SSP-SP' },
    consentSource: 'WEB_FORM' as const,
    context: userContext,
    ...overrides,
  };
}

describe('RegisterCustomerUseCase', () => {
  it('cadastra e devolve os dados mascarados', async () => {
    const ctx = setup();
    const customer = await ctx.register.execute(registrationPayload());

    expect(customer.cpf).toBe('***.***.247-25');
    expect(customer.email).toBe('ma*********@exemplo.com.br');
    expect(customer.fullName).toBe('Maria A. d. S.');
    expect(customer.status).toBe('PENDING_VERIFICATION');
  });

  it('nunca devolve o CPF em claro na resposta do cadastro', async () => {
    const ctx = setup();
    const customer = await ctx.register.execute(registrationPayload());
    expect(JSON.stringify(customer)).not.toContain(VALID_CPF);
  });

  it('registra o cadastro na trilha de auditoria', async () => {
    const ctx = setup();
    await ctx.register.execute(registrationPayload());

    expect(ctx.uow.auditLog.actions()).toEqual([DataAccessAction.CREATE]);
    expect(ctx.uow.auditLog.entries[0]?.purpose).toBe('ATENDIMENTO');
  });

  it('publica evento sem nenhum dado pessoal no payload', async () => {
    const ctx = setup();
    await ctx.register.execute(registrationPayload());

    const event = ctx.uow.outbox.records[0]!.event;
    expect(event.eventType).toBe(CustomerEventType.REGISTERED);
    expect(JSON.stringify(event)).not.toContain(VALID_CPF);
    expect(JSON.stringify(event)).not.toContain('maria.silva@exemplo.com.br');
  });

  it('recusa CPF já cadastrado, sem revelar o número na mensagem', async () => {
    const ctx = setup();
    await ctx.register.execute(registrationPayload());

    const error = await ctx.register
      .execute(registrationPayload({ email: 'outro@exemplo.com' }))
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(DuplicateResourceError);
    expect((error as Error).message).toContain('***.***.247-25');
    expect((error as Error).message).not.toContain(VALID_CPF);
  });

  it('recusa e-mail já cadastrado', async () => {
    const ctx = setup();
    await ctx.register.execute(registrationPayload());

    await expect(ctx.register.execute(registrationPayload({ cpf: VALID_CPF_2 }))).rejects.toThrow(
      DuplicateResourceError,
    );
  });
});

describe('GetCustomerUseCase', () => {
  it('devolve dados mascarados e audita a leitura', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());

    const found = await ctx.get.execute(created.id, userContext);

    expect(found.cpf).toBe('***.***.247-25');
    expect(ctx.uow.auditLog.actions()).toContain(DataAccessAction.READ_MASKED);
  });

  it('falha para cliente inexistente', async () => {
    const ctx = setup();
    await expect(ctx.get.execute('99999999-9999-4999-8999-999999999999', userContext)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('UpdateCustomerUseCase', () => {
  it('atualiza contato e audita quais campos mudaram', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());

    await ctx.update.execute({
      customerId: created.id,
      phone: '11912345678',
      context: userContext,
    });

    const entry = ctx.uow.auditLog.entries.find((item) => item.action === DataAccessAction.UPDATE);
    expect(entry?.fieldsAccessed).toEqual(['phone']);
  });

  it('recusa e-mail já usado por outro titular', async () => {
    const ctx = setup();
    const first = await ctx.register.execute(registrationPayload());
    await ctx.register.execute(
      registrationPayload({ cpf: VALID_CPF_2, email: 'outro@exemplo.com' }),
    );

    await expect(
      ctx.update.execute({
        customerId: first.id,
        email: 'outro@exemplo.com',
        context: userContext,
      }),
    ).rejects.toThrow(DuplicateResourceError);
  });

  it('devolve conflito quando a versão em banco avançou', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());
    ctx.uow.customers.failNextUpdate = true;

    await expect(
      ctx.update.execute({ customerId: created.id, phone: '11912345678', context: userContext }),
    ).rejects.toThrow();
  });
});

describe('Elegibilidade e exportação de dados', () => {
  let ctx: ReturnType<typeof setup>;
  let customerId: string;

  beforeEach(async () => {
    ctx = setup();
    customerId = (await ctx.register.execute(registrationPayload())).id;
  });

  it('cadastro não verificado é inelegível', async () => {
    const result = await ctx.eligibility.execute(customerId, sagaContext);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('EMAIL_NAO_VERIFICADO');
  });

  it('cadastro ativo é elegível e a verificação não expõe dado pessoal', async () => {
    await ctx.status.activate(customerId, userContext);
    const result = await ctx.eligibility.execute(customerId, sagaContext);

    expect(result.eligible).toBe(true);
    expect(JSON.stringify(result)).not.toContain(VALID_CPF);
  });

  it('registra na auditoria a consulta a cliente inexistente (sinal de enumeração)', async () => {
    await expect(
      ctx.eligibility.execute('99999999-9999-4999-8999-999999999999', sagaContext),
    ).rejects.toThrow(NotFoundError);

    const denied = ctx.uow.auditLog.entries.find((entry) => entry.outcome === 'DENIED');
    expect(denied?.denialReason).toBe('CLIENTE_NAO_ENCONTRADO');
  });

  it('perfil de cobrança devolve dado em claro e registra os campos acessados', async () => {
    await ctx.status.activate(customerId, userContext);
    const profile = await ctx.export.billingProfile(customerId, {
      ...sagaContext,
      purpose: 'PAYMENT_CODE_ISSUANCE',
    });

    expect(profile.cpf).toBe(VALID_CPF);
    const entry = ctx.uow.auditLog.entries.find(
      (item) => item.action === DataAccessAction.EXPORT_FOR_BILLING,
    );
    expect(entry?.fieldsAccessed).toEqual(['fullName', 'cpf', 'email', 'phone']);
    expect(entry?.outcome).toBe('ALLOWED');
  });

  it('recusa o perfil de cobrança de cadastro inelegível e audita a negativa', async () => {
    await expect(
      ctx.export.billingProfile(customerId, { ...sagaContext, purpose: 'PAYMENT_CODE_ISSUANCE' }),
    ).rejects.toThrow(DataProtectionError);

    const denied = ctx.uow.auditLog.entries.find((entry) => entry.outcome === 'DENIED');
    expect(denied?.denialReason).toContain('EMAIL_NAO_VERIFICADO');
  });

  it('dossiê de documentação traz os campos do ATPV-e', async () => {
    await ctx.status.activate(customerId, userContext);
    const dossier = await ctx.export.documentationDossier(customerId, {
      ...sagaContext,
      purpose: 'VEHICLE_DOCUMENT_ISSUANCE',
    });

    expect(dossier.address.street).toBe('Avenida Paulista');
    expect(dossier.identityDocument.number).toBe('123456789');
  });

  it('recusa exportação após a anonimização', async () => {
    await ctx.status.activate(customerId, userContext);
    await ctx.anonymize.execute(customerId, userContext);

    await expect(
      ctx.export.billingProfile(customerId, { ...sagaContext, purpose: 'PAYMENT_CODE_ISSUANCE' }),
    ).rejects.toThrow(DataProtectionError);
  });

  it('portabilidade devolve os dados do titular junto com a trilha de acessos', async () => {
    await ctx.status.activate(customerId, userContext);
    const exported = await ctx.export.dataSubjectExport(customerId, {
      ...userContext,
      purpose: 'DATA_SUBJECT_REQUEST',
    });

    expect(exported.personalData.cpf).toBe(VALID_CPF);
    expect(exported.accessLog.length).toBeGreaterThan(0);
  });
});

describe('AnonymizeCustomerUseCase', () => {
  it('apaga os dados, audita e publica o evento', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());

    const result = await ctx.anonymize.execute(created.id, userContext);

    expect(result.alreadyAnonymized).toBe(false);
    expect(ctx.uow.auditLog.actions()).toContain(DataAccessAction.ANONYMIZE);
    expect(ctx.uow.outbox.eventTypes()).toContain(CustomerEventType.ANONYMIZED);

    const after = await ctx.get.execute(created.id, userContext);
    expect(after.cpf).toBeNull();
    expect(after.status).toBe('ANONYMIZED');
  });

  it('é idempotente', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());
    await ctx.anonymize.execute(created.id, userContext);

    const second = await ctx.anonymize.execute(created.id, userContext);
    expect(second.alreadyAnonymized).toBe(true);
  });

  it('a trilha de auditoria sobrevive à anonimização', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());
    await ctx.anonymize.execute(created.id, userContext);

    const trail = await ctx.uow.auditLog.listByCustomer(created.id, 100);
    expect(trail.length).toBeGreaterThan(1);
    expect(JSON.stringify(trail)).not.toContain(VALID_CPF);
  });
});

describe('ManageConsentUseCase', () => {
  it('concede e revoga finalidade opcional, publicando eventos', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());

    await ctx.consent.grant({
      customerId: created.id,
      purpose: ConsentPurpose.MARKETING,
      source: 'WEB_FORM',
      context: userContext,
    });
    const afterRevoke = await ctx.consent.revoke({
      customerId: created.id,
      purpose: ConsentPurpose.MARKETING,
      context: userContext,
    });

    expect(
      afterRevoke.consents.find((item) => item.purpose === ConsentPurpose.MARKETING)?.granted,
    ).toBe(false);
    expect(ctx.uow.outbox.eventTypes()).toContain(CustomerEventType.CONSENT_GRANTED);
    expect(ctx.uow.outbox.eventTypes()).toContain(CustomerEventType.CONSENT_REVOKED);
  });

  it('recusa revogar finalidade essencial', async () => {
    const ctx = setup();
    const created = await ctx.register.execute(registrationPayload());

    await expect(
      ctx.consent.revoke({
        customerId: created.id,
        purpose: ConsentPurpose.PURCHASE_PROCESSING,
        context: userContext,
      }),
    ).rejects.toThrow();
  });
});
