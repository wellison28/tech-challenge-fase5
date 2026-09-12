import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../../src/infrastructure/config/env';
import { buildContainer } from '../../src/infrastructure/container';
import { LocalFieldCipher } from '../../src/infrastructure/crypto/local-field-cipher';
import { buildApp } from '../../src/infrastructure/http/app';
import {
  ROLE_ADMIN,
  ROLE_SUPPORT,
  SCOPE_BILLING,
  SCOPE_DOCUMENTATION,
  SCOPE_ELIGIBILITY,
} from '../../src/infrastructure/http/routes/customer-routes';
import { FakeClock, RecordingEventPublisher, SequentialIdGenerator, VALID_CPF, VALID_CPF_2 } from '../support/fakes';
import { InMemoryUnitOfWork } from '../support/in-memory-unit-of-work';

const JWT_SECRET = 'segredo-de-teste-com-tamanho-suficiente';
const MASTER_KEY = Buffer.from('chave-mestra-de-teste-com-32-byte').toString('base64');

async function signToken(claims: { roles?: string[]; scope?: string; sub?: string }) {
  return new SignJWT({ roles: claims.roles, scope: claims.scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? 'actor-test')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

const registration = {
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
  consentSource: 'WEB_FORM',
};

describe('API HTTP do customer-service', () => {
  let app: FastifyInstance;
  let uow: InMemoryUnitOfWork;
  let adminToken: string;
  let supportToken: string;
  let sagaToken: string;

  beforeAll(async () => {
    adminToken = await signToken({ roles: [ROLE_ADMIN], sub: 'admin-1' });
    supportToken = await signToken({ roles: [ROLE_SUPPORT], sub: 'support-1' });
    sagaToken = await signToken({
      scope: `${SCOPE_ELIGIBILITY} ${SCOPE_BILLING} ${SCOPE_DOCUMENTATION}`,
      sub: 'sales-service',
    });
  });

  beforeEach(async () => {
    await app?.close();
    resetEnvCache();

    uow = new InMemoryUnitOfWork();
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://user:pass@localhost:5433/test',
      AUTH_MODE: 'dev',
      JWT_DEV_SECRET: JWT_SECRET,
      CRYPTO_MODE: 'local',
      LOCAL_MASTER_KEY: MASTER_KEY,
      CPF_BLIND_INDEX_PEPPER: 'pepper-de-teste-com-tamanho-ok',
      PRIVACY_POLICY_VERSION: '2026-01',
    } as NodeJS.ProcessEnv);

    const container = await buildContainer({
      env,
      unitOfWork: uow,
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
      publisher: new RecordingEventPublisher(),
      cipher: new LocalFieldCipher(MASTER_KEY),
      prisma: { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient,
    });

    app = await buildApp(container);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    resetEnvCache();
  });

  /** Autocadastro feito pela própria conta: cada chamada, por padrão, é uma conta nova. */
  const register = async (overrides: Record<string, unknown> = {}, account = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/customers',
      headers: {
        authorization: `Bearer ${await signToken({ sub: account })}`,
        'x-data-purpose': 'SELF_REGISTRATION',
      },
      payload: { ...registration, ...overrides },
    });

  describe('cadastro', () => {
    it('cadastra e devolve 201 com dados mascarados', async () => {
      const response = await register();

      expect(response.statusCode).toBe(201);
      expect(response.json().cpf).toBe('***.***.247-25');
      expect(response.headers.location).toMatch(/^\/customers\//);
    });

    it('o corpo da resposta nunca contém o CPF em claro', async () => {
      const response = await register();
      expect(response.body).not.toContain(VALID_CPF);
    });

    it('recusa cadastro sem a finalidade declarada', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/customers',
        headers: { authorization: `Bearer ${await signToken({ sub: randomUUID() })}` },
        payload: registration,
      });
      expect(response.statusCode).toBe(403);
    });

    it('recusa finalidade não permitida nesta rota', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/customers',
        headers: {
          authorization: `Bearer ${await signToken({ sub: randomUUID() })}`,
          'x-data-purpose': 'MARKETING_ANALYTICS',
        },
        payload: registration,
      });
      expect(response.statusCode).toBe(403);
    });

    it('recusa CPF com dígitos verificadores inválidos', async () => {
      expect((await register({ cpf: '12345678900' })).statusCode).toBe(400);
    });

    it('recusa menor de idade', async () => {
      expect((await register({ birthDate: '2015-01-01' })).statusCode).toBe(422);
    });

    it('recusa CPF duplicado com 409', async () => {
      await register();
      const response = await register({ email: 'outro@exemplo.com' });

      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain(VALID_CPF);
    });

    it('exige login para cadastrar', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/customers',
        headers: { 'x-data-purpose': 'SELF_REGISTRATION' },
        payload: registration,
      });
      expect(response.statusCode).toBe(401);
    });

    it('o id do cadastro é o sub da conta que se cadastrou', async () => {
      const account = randomUUID();
      const response = await register({}, account);

      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe(account);
    });

    it('recusa um segundo cadastro para a mesma conta', async () => {
      const account = randomUUID();
      await register({}, account);

      const response = await register({ cpf: VALID_CPF_2, email: 'outra@exemplo.com' }, account);
      expect(response.statusCode).toBe(409);
    });

    it('um comprador não cria cadastro para outra conta', async () => {
      const response = await register({ customerId: randomUUID() });
      expect(response.statusCode).toBe(403);
    });

    it('token máquina-a-máquina não faz autocadastro', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/customers',
        headers: { authorization: `Bearer ${sagaToken}`, 'x-data-purpose': 'SELF_REGISTRATION' },
        payload: registration,
      });
      expect(response.statusCode).toBe(403);
    });

    it('na loja, o admin cadastra informando o sub da conta do comprador', async () => {
      const account = randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: '/customers',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'x-data-purpose': 'IN_STORE_REGISTRATION',
        },
        payload: { ...registration, consentSource: 'IN_STORE', customerId: account },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe(account);
    });

    it('cadastro na loja é exclusivo do admin', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/customers',
        headers: {
          authorization: `Bearer ${await signToken({ sub: randomUUID() })}`,
          'x-data-purpose': 'IN_STORE_REGISTRATION',
        },
        payload: { ...registration, customerId: randomUUID() },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('controle de acesso ao cadastro', () => {
    it('o titular acessa o próprio cadastro', async () => {
      const id = (await register()).json().id;
      const ownerToken = await signToken({ sub: id });

      const response = await app.inject({
        method: 'GET',
        url: `/customers/${id}`,
        headers: { authorization: `Bearer ${ownerToken}`, 'x-data-purpose': 'SELF_SERVICE' },
      });
      expect(response.statusCode).toBe(200);
    });

    it('um titular NÃO acessa o cadastro de outro', async () => {
      const id = (await register()).json().id;
      const intruderToken = await signToken({ sub: '99999999-9999-4999-8999-999999999999' });

      const response = await app.inject({
        method: 'GET',
        url: `/customers/${id}`,
        headers: { authorization: `Bearer ${intruderToken}`, 'x-data-purpose': 'SELF_SERVICE' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('atendimento vê o cadastro, mas sempre mascarado', async () => {
      const id = (await register()).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/customers/${id}`,
        headers: { authorization: `Bearer ${supportToken}`, 'x-data-purpose': 'ATENDIMENTO' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(VALID_CPF);
      expect(response.json().cpf).toBe('***.***.247-25');
    });

    it('atendimento NÃO alcança o perfil de cobrança', async () => {
      const id = (await register()).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/billing-profile`,
        headers: {
          authorization: `Bearer ${supportToken}`,
          'x-data-purpose': 'PAYMENT_CODE_ISSUANCE',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('exige autenticação para consultar cadastro', async () => {
      const id = (await register()).json().id;
      const response = await app.inject({
        method: 'GET',
        url: `/customers/${id}`,
        headers: { 'x-data-purpose': 'ATENDIMENTO' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('integração com a SAGA', () => {
    async function activeCustomerId(cpf = VALID_CPF, email = registration.email) {
      const id = (await register({ cpf, email })).json().id;
      await app.inject({
        method: 'POST',
        url: `/customers/${id}/activation`,
        headers: { authorization: `Bearer ${adminToken}`, 'x-data-purpose': 'ATIVACAO_CADASTRO' },
      });
      return id;
    }

    it('elegibilidade devolve apenas o veredito, sem dado pessoal', async () => {
      const id = await activeCustomerId();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/eligibility`,
        headers: { authorization: `Bearer ${sagaToken}`, 'x-data-purpose': 'PURCHASE_SAGA' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ customerId: id, eligible: true, reasons: [] });
      expect(response.body).not.toContain(VALID_CPF);
    });

    it('cadastro não ativado é inelegível', async () => {
      const id = (await register({ cpf: VALID_CPF_2, email: 'joao@exemplo.com' })).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/eligibility`,
        headers: { authorization: `Bearer ${sagaToken}`, 'x-data-purpose': 'PURCHASE_SAGA' },
      });

      expect(response.json().eligible).toBe(false);
      expect(response.json().reasons).toContain('EMAIL_NAO_VERIFICADO');
    });

    it('perfil de cobrança devolve dado em claro sob escopo e finalidade próprios', async () => {
      const id = await activeCustomerId();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/billing-profile`,
        headers: { authorization: `Bearer ${sagaToken}`, 'x-data-purpose': 'PAYMENT_CODE_ISSUANCE' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().cpf).toBe(VALID_CPF);
    });

    it('recusa o perfil de cobrança quando a finalidade declarada não confere', async () => {
      const id = await activeCustomerId();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/billing-profile`,
        headers: { authorization: `Bearer ${sagaToken}`, 'x-data-purpose': 'PURCHASE_SAGA' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('dossiê de documentação exige o escopo próprio', async () => {
      const id = await activeCustomerId();
      const onlyEligibility = await signToken({ scope: SCOPE_ELIGIBILITY, sub: 'sales-service' });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/documentation-dossier`,
        headers: {
          authorization: `Bearer ${onlyEligibility}`,
          'x-data-purpose': 'VEHICLE_DOCUMENT_ISSUANCE',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('toda leitura de dado em claro deixa registro de auditoria', async () => {
      const id = await activeCustomerId();
      await app.inject({
        method: 'GET',
        url: `/internal/customers/${id}/billing-profile`,
        headers: { authorization: `Bearer ${sagaToken}`, 'x-data-purpose': 'PAYMENT_CODE_ISSUANCE' },
      });

      const entry = uow.auditLog.entries.find((item) => item.action === 'EXPORT_FOR_BILLING');
      expect(entry).toMatchObject({
        actorId: 'sales-service',
        actorType: 'SERVICE',
        purpose: 'PAYMENT_CODE_ISSUANCE',
        outcome: 'ALLOWED',
      });
      expect(entry?.fieldsAccessed).toContain('cpf');
    });
  });

  describe('direitos do titular', () => {
    it('o titular revoga consentimento de marketing', async () => {
      const id = (await register({ optionalConsents: ['MARKETING'] })).json().id;
      const ownerToken = await signToken({ sub: id });

      const response = await app.inject({
        method: 'DELETE',
        url: `/customers/${id}/consents/MARKETING`,
        headers: { authorization: `Bearer ${ownerToken}`, 'x-data-purpose': 'SELF_SERVICE' },
      });

      expect(response.statusCode).toBe(200);
      const marketing = response
        .json()
        .consents.find((item: { purpose: string }) => item.purpose === 'MARKETING');
      expect(marketing.granted).toBe(false);
    });

    it('recusa revogar finalidade essencial ao contrato', async () => {
      const id = (await register()).json().id;
      const ownerToken = await signToken({ sub: id });

      const response = await app.inject({
        method: 'DELETE',
        url: `/customers/${id}/consents/PURCHASE_PROCESSING`,
        headers: { authorization: `Bearer ${ownerToken}`, 'x-data-purpose': 'SELF_SERVICE' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('anonimiza o cadastro a pedido do titular', async () => {
      const id = (await register()).json().id;
      const ownerToken = await signToken({ sub: id });

      const response = await app.inject({
        method: 'DELETE',
        url: `/customers/${id}`,
        headers: { authorization: `Bearer ${ownerToken}`, 'x-data-purpose': 'DATA_SUBJECT_REQUEST' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().alreadyAnonymized).toBe(false);

      const after = await app.inject({
        method: 'GET',
        url: `/customers/${id}`,
        headers: { authorization: `Bearer ${adminToken}`, 'x-data-purpose': 'ATENDIMENTO' },
      });
      expect(after.json().cpf).toBeNull();
      expect(after.json().status).toBe('ANONYMIZED');
    });

    it('exporta os dados do titular com a trilha de acessos (portabilidade)', async () => {
      const id = (await register()).json().id;
      const ownerToken = await signToken({ sub: id });

      const response = await app.inject({
        method: 'GET',
        url: `/customers/${id}/personal-data-export`,
        headers: { authorization: `Bearer ${ownerToken}`, 'x-data-purpose': 'DATA_SUBJECT_REQUEST' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().personalData.cpf).toBe(VALID_CPF);
      expect(Array.isArray(response.json().accessLog)).toBe(true);
    });

    it('exige a finalidade DATA_SUBJECT_REQUEST para exportar', async () => {
      const id = (await register()).json().id;
      const ownerToken = await signToken({ sub: id });

      const response = await app.inject({
        method: 'GET',
        url: `/customers/${id}/personal-data-export`,
        headers: { authorization: `Bearer ${ownerToken}`, 'x-data-purpose': 'CURIOSIDADE' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('saúde', () => {
    it('readiness verifica banco e criptografia', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.json()).toEqual({
        status: 'ready',
        dependencies: { database: 'up', crypto: 'up' },
      });
    });
  });
});
