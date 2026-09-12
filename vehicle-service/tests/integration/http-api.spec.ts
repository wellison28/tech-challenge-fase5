import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer } from '../../src/infrastructure/container';
import { loadEnv, resetEnvCache } from '../../src/infrastructure/config/env';
import { buildApp } from '../../src/infrastructure/http/app';
import { ROLE_ADMIN, SCOPE_RESERVE, SCOPE_SELL } from '../../src/infrastructure/http/routes/vehicle-routes';
import { FakeClock, RecordingEventPublisher, SequentialIdGenerator } from '../support/fakes';
import { InMemoryUnitOfWork } from '../support/in-memory-unit-of-work';

const JWT_SECRET = 'segredo-de-teste-com-tamanho-suficiente';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function signToken(claims: { roles?: string[]; scope?: string }): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-test')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

const vehiclePayload = {
  vin: '9BWZZZ377VT004251',
  licensePlate: 'ABC1D23',
  brand: 'Volkswagen',
  model: 'Nivus',
  modelYear: 2024,
  manufactureYear: 2023,
  color: 'Prata',
  mileageKm: 18_500,
  fuelType: 'FLEX',
  transmission: 'AUTOMATIC',
  priceInCents: 12_990_000,
};

describe('API HTTP do vehicle-service', () => {
  let app: FastifyInstance;
  let uow: InMemoryUnitOfWork;
  let adminToken: string;
  let sagaToken: string;
  let customerToken: string;

  beforeAll(async () => {
    adminToken = await signToken({ roles: [ROLE_ADMIN] });
    sagaToken = await signToken({ scope: `${SCOPE_RESERVE} ${SCOPE_SELL}` });
    customerToken = await signToken({ roles: ['customer'] });
  });

  beforeEach(async () => {
    await app?.close();
    resetEnvCache();

    uow = new InMemoryUnitOfWork();
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      AUTH_MODE: 'dev',
      JWT_DEV_SECRET: JWT_SECRET,
      RESERVATION_TTL_MINUTES: '30',
    } as NodeJS.ProcessEnv);

    const container = buildContainer({
      env,
      unitOfWork: uow,
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
      publisher: new RecordingEventPublisher(),
      // O readiness é o único ponto que toca o Prisma direto; aqui basta um dublê.
      prisma: { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient,
    });

    app = await buildApp(container);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    resetEnvCache();
  });

  async function createVehicle(overrides: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/vehicles',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ...vehiclePayload, ...overrides },
    });
    return response;
  }

  describe('cadastro e edição', () => {
    it('cadastra um veículo e devolve 201 com Location', async () => {
      const response = await createVehicle();

      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toMatch(/^\/vehicles\//);
      expect(response.json()).toMatchObject({ status: 'AVAILABLE', brand: 'Volkswagen' });
    });

    it('recusa cadastro sem token', async () => {
      const response = await app.inject({ method: 'POST', url: '/vehicles', payload: vehiclePayload });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('UNAUTHORIZED');
    });

    it('recusa cadastro feito por um comprador', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/vehicles',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: vehiclePayload,
      });
      expect(response.statusCode).toBe(403);
    });

    it('valida o corpo da requisição', async () => {
      const response = await createVehicle({ priceInCents: -5 });
      expect(response.statusCode).toBe(400);
    });

    it('edita o veículo', async () => {
      const created = await createVehicle();
      const response = await app.inject({
        method: 'PUT',
        url: `/vehicles/${created.json().id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { priceInCents: 11_900_000, color: 'Preto' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ priceInCents: 11_900_000, color: 'Preto' });
    });

    it('devolve 404 para veículo inexistente', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/vehicles/99999999-9999-4999-8999-999999999999',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('catálogo público', () => {
    it('lista veículos à venda ordenados do mais barato para o mais caro', async () => {
      await createVehicle({ vin: '9BWZZZ377VT000001', licensePlate: 'AAA1A11', priceInCents: 9_000_000 });
      await createVehicle({ vin: '9BWZZZ377VT000002', licensePlate: 'BBB2B22', priceInCents: 4_500_000 });

      const response = await app.inject({ method: 'GET', url: '/vehicles/available' });

      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((v: { priceInCents: number }) => v.priceInCents)).toEqual([
        4_500_000, 9_000_000,
      ]);
    });

    it('não exige autenticação para consultar a vitrine', async () => {
      const response = await app.inject({ method: 'GET', url: '/vehicles/sold' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('passos da SAGA', () => {
    it('reserva, confirma a venda e move o veículo para a lista de vendidos', async () => {
      const vehicleId = (await createVehicle()).json().id;

      const reserved = await app.inject({
        method: 'POST',
        url: `/vehicles/${vehicleId}/reservations`,
        headers: { authorization: `Bearer ${sagaToken}` },
        payload: { customerId: CUSTOMER_ID, orderId: ORDER_ID },
      });
      expect(reserved.statusCode).toBe(201);
      expect(reserved.json().alreadyReserved).toBe(false);

      const sold = await app.inject({
        method: 'POST',
        url: `/vehicles/${vehicleId}/sale`,
        headers: { authorization: `Bearer ${sagaToken}` },
        payload: { customerId: CUSTOMER_ID, orderId: ORDER_ID },
      });
      expect(sold.statusCode).toBe(200);

      const soldList = await app.inject({ method: 'GET', url: '/vehicles/sold' });
      expect(soldList.json().total).toBe(1);
    });

    it('devolve 409 quando outro pedido já reservou o veículo', async () => {
      const vehicleId = (await createVehicle()).json().id;
      const reserve = (orderId: string) =>
        app.inject({
          method: 'POST',
          url: `/vehicles/${vehicleId}/reservations`,
          headers: { authorization: `Bearer ${sagaToken}` },
          payload: { customerId: CUSTOMER_ID, orderId },
        });

      await reserve(ORDER_ID);
      const second = await reserve('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('CONFLICT');
    });

    it('reexecução do passo devolve 200 e a mesma reserva', async () => {
      const vehicleId = (await createVehicle()).json().id;
      const payload = { customerId: CUSTOMER_ID, orderId: ORDER_ID };
      const headers = { authorization: `Bearer ${sagaToken}` };
      const url = `/vehicles/${vehicleId}/reservations`;

      const first = await app.inject({ method: 'POST', url, headers, payload });
      const retry = await app.inject({ method: 'POST', url, headers, payload });

      expect(retry.statusCode).toBe(200);
      expect(retry.json().reservationId).toBe(first.json().reservationId);
    });

    it('libera a reserva na compensação e o veículo volta à vitrine', async () => {
      const vehicleId = (await createVehicle()).json().id;
      await app.inject({
        method: 'POST',
        url: `/vehicles/${vehicleId}/reservations`,
        headers: { authorization: `Bearer ${sagaToken}` },
        payload: { customerId: CUSTOMER_ID, orderId: ORDER_ID },
      });

      const released = await app.inject({
        method: 'POST',
        url: `/vehicles/${vehicleId}/reservations/release`,
        headers: { authorization: `Bearer ${sagaToken}` },
        payload: { orderId: ORDER_ID, reason: 'PAYMENT_FAILED' },
      });

      expect(released.statusCode).toBe(200);
      expect(released.json().released).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/vehicles/available' })).json().total).toBe(1);
    });

    it('um token de comprador não alcança os passos da SAGA', async () => {
      const vehicleId = (await createVehicle()).json().id;
      const response = await app.inject({
        method: 'POST',
        url: `/vehicles/${vehicleId}/reservations`,
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { customerId: CUSTOMER_ID, orderId: ORDER_ID },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('observabilidade e saúde', () => {
    it('propaga o correlation id informado pelo cliente', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/vehicles/available',
        headers: { 'x-correlation-id': 'trace-abc-123' },
      });
      expect(response.headers['x-correlation-id']).toBe('trace-abc-123');
    });

    it('responde ao liveness sem tocar no banco', async () => {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });

    it('readiness verifica o banco', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.json()).toMatchObject({ status: 'ready' });
    });

    it('rota inexistente devolve 404 com corpo padronizado', async () => {
      const response = await app.inject({ method: 'GET', url: '/nao-existe' });
      expect(response.json().code).toBe('ROUTE_NOT_FOUND');
    });
  });
});
