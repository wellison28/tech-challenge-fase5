import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentGateway } from '../../src/infrastructure/clients/payment-gateway';
import { loadEnv, resetEnvCache } from '../../src/infrastructure/config/env';
import { buildContainer } from '../../src/infrastructure/container';
import { buildApp } from '../../src/infrastructure/http/app';
import { ROLE_ADMIN, ROLE_CUSTOMER } from '../../src/infrastructure/http/routes/order-routes';
import { FakeClock, RecordingEventPublisher, SequentialIdGenerator } from '../support/fakes';
import { InMemoryUnitOfWork } from '../support/in-memory-unit-of-work';
import { FakeCustomerDirectory, FakeVehicleCatalog } from '../support/partner-doubles';

const JWT_SECRET = 'segredo-de-teste-com-tamanho-suficiente';
const WEBHOOK_SECRET = 'segredo-de-webhook-para-testes';
const CUSTOMER_A = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_B = '33333333-3333-4333-8333-333333333333';
const VEHICLE = '22222222-2222-4222-8222-222222222222';

async function signToken(claims: { roles: string[]; sub: string }) {
  return new SignJWT({ roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe('API HTTP do sales-service', () => {
  let app: FastifyInstance;
  let uow: InMemoryUnitOfWork;
  let vehicles: FakeVehicleCatalog;
  let customers: FakeCustomerDirectory;
  let payments: FakePaymentGateway;
  let clock: FakeClock;
  let buyerToken: string;
  let otherBuyerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    buyerToken = await signToken({ roles: [ROLE_CUSTOMER], sub: CUSTOMER_A });
    otherBuyerToken = await signToken({ roles: [ROLE_CUSTOMER], sub: CUSTOMER_B });
    adminToken = await signToken({ roles: [ROLE_ADMIN], sub: 'admin-1' });
  });

  beforeEach(async () => {
    await app?.close();
    resetEnvCache();

    uow = new InMemoryUnitOfWork();
    vehicles = new FakeVehicleCatalog();
    customers = new FakeCustomerDirectory();
    clock = new FakeClock();
    payments = new FakePaymentGateway(WEBHOOK_SECRET, () => clock.now());

    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://user:pass@localhost:5434/test',
      AUTH_MODE: 'dev',
      JWT_DEV_SECRET: JWT_SECRET,
      SAGA_MODE: 'inline',
      VEHICLE_SERVICE_URL: 'http://localhost:3001',
      CUSTOMER_SERVICE_URL: 'http://localhost:3002',
      PAYMENT_PROVIDER: 'fake',
      PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PAYMENT_WINDOW_MINUTES: '25',
      VEHICLE_RESERVATION_TTL_MINUTES: '30',
    } as NodeJS.ProcessEnv);

    const container = buildContainer({
      env,
      unitOfWork: uow,
      clock,
      ids: new SequentialIdGenerator(),
      publisher: new RecordingEventPublisher(),
      vehicles,
      customers,
      payments,
      prisma: { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient,
    });

    app = await buildApp(container);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    resetEnvCache();
  });

  const startPurchase = (token = buyerToken, vehicleId = VEHICLE) =>
    app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { vehicleId },
    });

  async function sendWebhook(chargeId: string, status: 'PAID' | 'REFUSED' | 'EXPIRED') {
    const body = JSON.stringify({ eventId: `evt-${chargeId}`, chargeId, status });
    return app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: {
        'content-type': 'application/json',
        'x-signature': payments.signPayload(body),
      },
      payload: body,
    });
  }

  describe('início da compra', () => {
    it('reserva o veículo e devolve o código de pagamento ao comprador', async () => {
      const response = await startPurchase();

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        status: 'AWAITING_PAYMENT',
        customerId: CUSTOMER_A,
        vehicleId: VEHICLE,
        amountInCents: 12_990_000,
      });
      expect(response.json().paymentCode).toBeTruthy();
    });

    it('exige autenticação', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: { vehicleId: VEHICLE },
      });
      expect(response.statusCode).toBe(401);
    });

    it('um comprador não abre pedido em nome de outro', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${buyerToken}` },
        payload: { vehicleId: VEHICLE, customerId: CUSTOMER_B },
      });
      expect(response.statusCode).toBe(403);
    });

    it('a loja pode abrir pedido em nome do cliente (venda presencial)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { vehicleId: VEHICLE, customerId: CUSTOMER_A },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().customerId).toBe(CUSTOMER_A);
    });

    it('o segundo comprador recebe o pedido cancelado por indisponibilidade', async () => {
      await startPurchase(buyerToken);
      const second = await startPurchase(otherBuyerToken);

      expect(second.statusCode).toBe(201);
      expect(second.json()).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'VEHICLE_UNAVAILABLE',
      });
    });
  });

  describe('consulta de pedidos', () => {
    it('devolve a linha do tempo da SAGA', async () => {
      const orderId = (await startPurchase()).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/orders/${orderId}`,
        headers: { authorization: `Bearer ${buyerToken}` },
      });

      expect(response.json().timeline.map((entry: { step: string }) => entry.step)).toEqual([
        'RESERVE_VEHICLE',
        'VALIDATE_CUSTOMER',
        'CREATE_PAYMENT',
      ]);
    });

    it('um comprador não consulta o pedido de outro', async () => {
      const orderId = (await startPurchase()).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/orders/${orderId}`,
        headers: { authorization: `Bearer ${otherBuyerToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('o código de pagamento não é exposto à equipe da revenda', async () => {
      const orderId = (await startPurchase()).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/orders/${orderId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().paymentCode).toBeNull();
    });

    it('a listagem de um comprador traz apenas os próprios pedidos', async () => {
      await startPurchase(buyerToken);
      await startPurchase(otherBuyerToken, '44444444-4444-4444-8444-444444444444');

      const response = await app.inject({
        method: 'GET',
        // Mesmo pedindo os pedidos de outra pessoa, o filtro é forçado.
        url: `/orders?customerId=${CUSTOMER_B}`,
        headers: { authorization: `Bearer ${buyerToken}` },
      });

      expect(response.json().total).toBe(1);
      expect(response.json().items[0].customerId).toBe(CUSTOMER_A);
    });
  });

  describe('webhook de pagamento', () => {
    it('conclui a venda com assinatura válida', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;

      const response = await sendWebhook(chargeId, 'PAID');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true, orderStatus: 'SALE_CONFIRMED' });
      expect(vehicles.soldVehicles.has(VEHICLE)).toBe(true);
    });

    it('recusa webhook sem assinatura', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: { 'content-type': 'application/json' },
        payload: { eventId: 'evt-1', chargeId, status: 'PAID' },
      });

      expect(response.statusCode).toBe(401);
      expect(vehicles.soldVehicles.has(VEHICLE)).toBe(false);
    });

    it('recusa assinatura forjada — ninguém leva um veículo sem pagar', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;
      const body = JSON.stringify({ eventId: 'evt-1', chargeId, status: 'PAID' });

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'content-type': 'application/json',
          'x-signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        },
        payload: body,
      });

      expect(response.statusCode).toBe(401);
      expect(vehicles.soldVehicles.has(VEHICLE)).toBe(false);
    });

    it('recusa corpo adulterado após a assinatura', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;
      const signed = JSON.stringify({ eventId: 'evt-1', chargeId, status: 'REFUSED' });
      const tampered = JSON.stringify({ eventId: 'evt-1', chargeId, status: 'PAID' });

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: {
          'content-type': 'application/json',
          'x-signature': payments.signPayload(signed),
        },
        payload: tampered,
      });

      expect(response.statusCode).toBe(401);
    });

    it('pagamento recusado devolve o veículo à vitrine', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;

      const response = await sendWebhook(chargeId, 'REFUSED');

      expect(response.json().orderStatus).toBe('CANCELLED');
      expect(vehicles.isReserved(VEHICLE)).toBe(false);
    });

    it('reentrega do mesmo webhook não vende duas vezes', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;

      await sendWebhook(chargeId, 'PAID');
      await sendWebhook(chargeId, 'PAID');

      expect(vehicles.calls.filter((call) => call === 'confirmSale')).toHaveLength(1);
    });
  });

  describe('desistência e retirada', () => {
    it('o cliente cancela e o veículo volta à vitrine', async () => {
      const orderId = (await startPurchase()).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/cancellation`,
        headers: { authorization: `Bearer ${buyerToken}` },
      });

      expect(response.json()).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'CUSTOMER_GAVE_UP',
      });
      expect(vehicles.isReserved(VEHICLE)).toBe(false);
    });

    it('um comprador não cancela o pedido de outro', async () => {
      const orderId = (await startPurchase()).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/cancellation`,
        headers: { authorization: `Bearer ${otherBuyerToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('a retirada só é registrada pela loja', async () => {
      const orderId = (await startPurchase()).json().id;
      const chargeId = (await uow.orders.findById(orderId))!.paymentChargeId!;
      await sendWebhook(chargeId, 'PAID');

      const byBuyer = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/pickup`,
        headers: { authorization: `Bearer ${buyerToken}` },
      });
      expect(byBuyer.statusCode).toBe(403);

      const byStore = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/pickup`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(byStore.json().status).toBe('COMPLETED');
    });

    it('recusa registrar retirada antes do pagamento', async () => {
      const orderId = (await startPurchase()).json().id;

      const response = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/pickup`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(response.statusCode).toBe(409);
    });
  });

  describe('observabilidade', () => {
    it('propaga o correlation id por toda a SAGA', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${buyerToken}`, 'x-correlation-id': 'trace-compra-1' },
        payload: { vehicleId: VEHICLE },
      });

      expect(response.headers['x-correlation-id']).toBe('trace-compra-1');
      expect(
        uow.outbox.records.every((record) => record.event.correlationId === 'trace-compra-1'),
      ).toBe(true);
    });

    it('expõe o modo de orquestração no health check', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.json().sagaMode).toBe('inline');
    });
  });
});
