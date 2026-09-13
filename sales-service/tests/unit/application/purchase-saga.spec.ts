import { beforeEach, describe, expect, it } from 'vitest';
import { EventFactory } from '../../../src/application/events/event-factory';
import { PurchaseSagaOrchestrator } from '../../../src/application/saga/orchestrator';
import { PurchaseSagaSteps } from '../../../src/application/saga/steps';
import { CancelPurchaseUseCase } from '../../../src/application/usecases/cancel-purchase';
import { ConfirmPaymentUseCase } from '../../../src/application/usecases/confirm-payment';
import { DeliverVehicleUseCase } from '../../../src/application/usecases/deliver-vehicle';
import { ExpireOrdersUseCase } from '../../../src/application/usecases/expire-orders';
import { RegisterPaymentWaiterUseCase } from '../../../src/application/usecases/register-payment-waiter';
import { StartPurchaseUseCase } from '../../../src/application/usecases/start-purchase';
import { CancellationReason, OrderStatus } from '../../../src/domain/entities/order';
import { ConflictError } from '../../../src/domain/errors/domain-error';
import { PaymentChargeStatus, PaymentGatewayPort } from '../../../src/application/ports/payment-gateway';
import { OrderEventType } from '../../../src/domain/events/domain-event';
import { InlineSagaLauncher } from '../../../src/infrastructure/saga/saga-launcher';
import { FakePaymentGateway } from '../../../src/infrastructure/clients/payment-gateway';
import { FakeClock, SequentialIdGenerator } from '../../support/fakes';
import { InMemoryUnitOfWork } from '../../support/in-memory-unit-of-work';
import {
  FakeCustomerDirectory,
  FakeVehicleCatalog,
  RecordingSagaCallback,
  SILENT_LOGGER,
} from '../../support/partner-doubles';

const CUSTOMER_A = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_B = '33333333-3333-4333-8333-333333333333';
const VEHICLE = '22222222-2222-4222-8222-222222222222';
const PAYMENT_WINDOW_MINUTES = 25;
const WEBHOOK_SECRET = 'segredo-de-webhook-para-testes';

function setup() {
  const uow = new InMemoryUnitOfWork();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator();
  const events = new EventFactory(ids, clock);
  const vehicles = new FakeVehicleCatalog();
  const customers = new FakeCustomerDirectory();
  const payments = new FakePaymentGateway(WEBHOOK_SECRET, () => clock.now());
  const callback = new RecordingSagaCallback();

  const steps = new PurchaseSagaSteps(
    uow, clock, events, vehicles, customers, payments, PAYMENT_WINDOW_MINUTES,
  );
  // Sem espera entre tentativas: mantém a suíte rápida.
  const orchestrator = new PurchaseSagaOrchestrator(steps, SILENT_LOGGER, 3);

  return {
    uow, clock, ids, vehicles, customers, payments, callback, steps, orchestrator,
    startPurchase: new StartPurchaseUseCase(
      uow, ids, clock, events, new InlineSagaLauncher(orchestrator),
    ),
    confirmPayment: new ConfirmPaymentUseCase(uow, clock, events, steps, callback),
    cancelPurchase: new CancelPurchaseUseCase(uow, clock, steps, callback),
    deliverVehicle: new DeliverVehicleUseCase(uow, clock, events),
    registerWaiter: new RegisterPaymentWaiterUseCase(uow, clock),
    expireOrders: new ExpireOrdersUseCase(uow, clock, steps, payments),
  };
}

describe('SAGA de compra — caminho feliz', () => {
  it('reserva, valida o comprador e emite o código de pagamento', async () => {
    const ctx = setup();

    const order = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    expect(order.status).toBe(OrderStatus.AWAITING_PAYMENT);
    expect(order.paymentCode).toBeTruthy();
    expect(order.amountInCents).toBe(12_990_000);
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(true);
  });

  it('executa os passos na ordem correta — veículo primeiro', async () => {
    const ctx = setup();
    await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    expect(ctx.vehicles.calls).toEqual(['reserve']);
    expect(ctx.customers.billingProfileCalls).toBe(1);
  });

  it('conclui a compra ponta a ponta, com baixa no estoque e retirada', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    ctx.payments.simulatePayment(chargeId);
    const paid = await ctx.confirmPayment.execute({
      chargeId, outcome: 'PAID', correlationId: 'corr-2',
    });
    expect(paid.status).toBe(OrderStatus.SALE_CONFIRMED);
    expect(ctx.vehicles.soldVehicles.has(VEHICLE)).toBe(true);

    const delivered = await ctx.deliverVehicle.execute({
      orderId: started.id, correlationId: 'corr-3',
    });
    expect(delivered.status).toBe(OrderStatus.COMPLETED);
    expect(delivered.deliveredAt).not.toBeNull();
  });

  it('publica a sequência de eventos esperada', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;
    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });
    await ctx.deliverVehicle.execute({ orderId: started.id, correlationId: 'corr-3' });

    expect(ctx.uow.outbox.eventTypes()).toEqual([
      OrderEventType.STARTED,
      OrderEventType.VEHICLE_RESERVED,
      OrderEventType.PAYMENT_CODE_ISSUED,
      OrderEventType.PAID,
      OrderEventType.SALE_CONFIRMED,
      OrderEventType.COMPLETED,
    ]);
  });

  it('nenhum evento publicado carrega dado pessoal do pagador', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;
    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });

    const serialized = JSON.stringify(ctx.uow.outbox.records);
    expect(serialized).not.toContain('52998224725');
    expect(serialized).not.toContain('maria.silva@exemplo.com.br');
    expect(serialized).not.toContain('Maria Aparecida');
  });
});

describe('SAGA — outro cliente reserva o veículo antes (cenário do enunciado)', () => {
  it('o segundo pedido é cancelado com VEHICLE_UNAVAILABLE', async () => {
    const ctx = setup();
    // O primeiro cliente conclui a reserva.
    await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-a',
    });

    const second = await ctx.startPurchase.execute({
      customerId: CUSTOMER_B, vehicleId: VEHICLE, correlationId: 'corr-b',
    });

    expect(second.status).toBe(OrderStatus.CANCELLED);
    expect(second.cancellationReason).toBe(CancellationReason.VEHICLE_UNAVAILABLE);
  });

  it('a reserva do primeiro cliente permanece intacta', async () => {
    const ctx = setup();
    const first = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-a',
    });
    await ctx.startPurchase.execute({
      customerId: CUSTOMER_B, vehicleId: VEHICLE, correlationId: 'corr-b',
    });

    const stillReserved = await ctx.uow.orders.findById(first.id);
    expect(stillReserved?.status).toBe(OrderStatus.AWAITING_PAYMENT);
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(true);
    // A compensação do segundo pedido não liberou a reserva do primeiro.
    expect(ctx.vehicles.releasedOrders).not.toContain(first.id);
  });

  it('não emite cobrança para o pedido perdedor', async () => {
    const ctx = setup();
    await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-a',
    });
    ctx.customers.billingProfileCalls = 0;

    const second = await ctx.startPurchase.execute({
      customerId: CUSTOMER_B, vehicleId: VEHICLE, correlationId: 'corr-b',
    });

    expect(ctx.customers.billingProfileCalls).toBe(0);
    expect(second.paymentCode).toBeNull();
  });

  it('recusa abrir um segundo pedido do mesmo cliente para o mesmo veículo', async () => {
    const ctx = setup();
    await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    await expect(
      ctx.startPurchase.execute({
        customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-2',
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('SAGA — comprador não habilitado', () => {
  it('compensa liberando a reserva e registra CUSTOMER_NOT_ELIGIBLE', async () => {
    const ctx = setup();
    ctx.customers.eligible = false;
    ctx.customers.reasons = ['EMAIL_NAO_VERIFICADO'];

    const order = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.cancellationReason).toBe(CancellationReason.CUSTOMER_NOT_ELIGIBLE);
    // O veículo voltou à vitrine: é o ponto central da compensação.
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(false);
    expect(ctx.vehicles.calls).toEqual(['reserve', 'release']);
  });

  it('não busca o perfil de cobrança de um comprador inelegível', async () => {
    const ctx = setup();
    ctx.customers.eligible = false;

    await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    expect(ctx.customers.billingProfileCalls).toBe(0);
  });
});

describe('SAGA — pagamento não efetuado', () => {
  it('pagamento recusado compensa e devolve o veículo ao estoque', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    const order = await ctx.confirmPayment.execute({
      chargeId, outcome: 'REFUSED', correlationId: 'corr-2',
    });

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.cancellationReason).toBe(CancellationReason.PAYMENT_REFUSED);
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(false);
  });

  it('pagamento confirmado depois do prazo é estornado, não concluído', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    ctx.clock.advanceMinutes(PAYMENT_WINDOW_MINUTES + 1);
    ctx.payments.simulatePayment(chargeId); // o dinheiro saiu da conta do cliente
    const order = await ctx.confirmPayment.execute({
      chargeId, outcome: 'PAID', correlationId: 'corr-2',
    });

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.cancellationReason).toBe(CancellationReason.PAYMENT_TIMEOUT);
    expect(ctx.vehicles.soldVehicles.has(VEHICLE)).toBe(false);
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(false);
    expect((await ctx.payments.getCharge({ chargeId })).status).toBe(PaymentChargeStatus.REFUNDED);
  });

  it('cobrança ainda não paga é cancelada, não estornada', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    await ctx.confirmPayment.execute({ chargeId, outcome: 'REFUSED', correlationId: 'corr-2' });

    expect((await ctx.payments.getCharge({ chargeId })).status).toBe(PaymentChargeStatus.CANCELLED);
  });

  it('estorno repetido na reexecução da compensação não devolve em dobro', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;
    ctx.payments.simulatePayment(chargeId);

    const refunds: string[] = [];
    const refund = ctx.payments.refundCharge.bind(ctx.payments);
    ctx.payments.refundCharge = async (params: Parameters<PaymentGatewayPort['refundCharge']>[0]) => {
      refunds.push(params.idempotencyKey);
      return refund(params);
    };

    const input = { orderId: started.id, correlationId: 'corr-2', reason: CancellationReason.SYSTEM_FAILURE };
    await ctx.steps.compensate(input);
    await ctx.steps.compensate(input);

    expect(refunds).toEqual([`${started.id}:refund`]);
    expect((await ctx.payments.getCharge({ chargeId })).status).toBe(PaymentChargeStatus.REFUNDED);
  });

  it('webhook reentregue após a conclusão não tem efeito', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });
    const again = await ctx.confirmPayment.execute({
      chargeId, outcome: 'PAID', correlationId: 'corr-3',
    });

    expect(again.status).toBe(OrderStatus.SALE_CONFIRMED);
    expect(ctx.vehicles.calls.filter((call) => call === 'confirmSale')).toHaveLength(1);
  });
});

describe('SAGA — desistência do cliente', () => {
  it('cancela e devolve o veículo ao estoque', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    const order = await ctx.cancelPurchase.execute({
      orderId: started.id, requestedBy: CUSTOMER_A, correlationId: 'corr-2',
    });

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.cancellationReason).toBe(CancellationReason.CUSTOMER_GAVE_UP);
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(false);
  });

  it('cancelar duas vezes é idempotente', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    await ctx.cancelPurchase.execute({
      orderId: started.id, requestedBy: CUSTOMER_A, correlationId: 'corr-2',
    });

    const second = await ctx.cancelPurchase.execute({
      orderId: started.id, requestedBy: CUSTOMER_A, correlationId: 'corr-3',
    });
    expect(second.status).toBe(OrderStatus.CANCELLED);
    expect(ctx.vehicles.calls.filter((call) => call === 'release')).toHaveLength(1);
  });

  it('não cancela um pedido já concluído', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;
    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });
    await ctx.deliverVehicle.execute({ orderId: started.id, correlationId: 'corr-3' });

    const order = await ctx.cancelPurchase.execute({
      orderId: started.id, requestedBy: CUSTOMER_A, correlationId: 'corr-4',
    });
    expect(order.status).toBe(OrderStatus.COMPLETED);
  });

  it('depois do pagamento a desistência é recusada, sem deixar o pedido pela metade', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;
    ctx.payments.simulatePayment(chargeId);
    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });

    await expect(
      ctx.cancelPurchase.execute({ orderId: started.id, requestedBy: CUSTOMER_A, correlationId: 'corr-3' }),
    ).rejects.toThrow(ConflictError);

    const order = (await ctx.uow.orders.findById(started.id))!;
    expect(order.status).toBe(OrderStatus.SALE_CONFIRMED);
    expect(ctx.vehicles.soldVehicles.has(VEHICLE)).toBe(true);
    expect(ctx.vehicles.calls).not.toContain('release');
    expect((await ctx.payments.getCharge({ chargeId })).status).toBe(PaymentChargeStatus.PAID);
  });

  it('libera o veículo para outro comprador depois da desistência', async () => {
    const ctx = setup();
    const first = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    await ctx.cancelPurchase.execute({
      orderId: first.id, requestedBy: CUSTOMER_A, correlationId: 'corr-2',
    });

    const second = await ctx.startPurchase.execute({
      customerId: CUSTOMER_B, vehicleId: VEHICLE, correlationId: 'corr-3',
    });
    expect(second.status).toBe(OrderStatus.AWAITING_PAYMENT);
  });
});

describe('SAGA — resiliência do orquestrador', () => {
  it('retenta falha transitória e segue adiante', async () => {
    const ctx = setup();
    ctx.vehicles.transientFailuresOnReserve = 2;

    const order = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    expect(order.status).toBe(OrderStatus.AWAITING_PAYMENT);
    expect(ctx.vehicles.calls.filter((call) => call === 'reserve')).toHaveLength(3);
  });

  it('não retenta falha definitiva — 409 não melhora com insistência', async () => {
    const ctx = setup();
    ctx.vehicles.reserveForAnotherOrder(VEHICLE, 'pedido-de-outro-cliente');

    await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    expect(ctx.vehicles.calls.filter((call) => call === 'reserve')).toHaveLength(1);
  });

  it('desiste após esgotar as tentativas e compensa como falha de sistema', async () => {
    const ctx = setup();
    ctx.vehicles.transientFailuresOnReserve = 99;

    const order = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });

    expect(order.status).toBe(OrderStatus.FAILED);
    expect(order.cancellationReason).toBe(CancellationReason.SYSTEM_FAILURE);
  });

  it('compensação incompleta mantém o pedido em COMPENSATING para alarme', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    ctx.vehicles.failReleaseOnce = true;

    await expect(
      ctx.steps.compensate({
        orderId: started.id,
        correlationId: 'corr-2',
        reason: CancellationReason.CUSTOMER_GAVE_UP,
      }),
    ).rejects.toThrow();

    const order = await ctx.uow.orders.findById(started.id);
    expect(order?.status).toBe(OrderStatus.COMPENSATING);
    expect(order?.timeline.some((entry) => entry.outcome === 'FAILED')).toBe(true);
  });

  it('reexecutar a compensação depois da falha conclui o cancelamento', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    ctx.vehicles.failReleaseOnce = true;
    await ctx.steps
      .compensate({
        orderId: started.id, correlationId: 'corr-2', reason: CancellationReason.CUSTOMER_GAVE_UP,
      })
      .catch(() => undefined);

    await ctx.steps.compensate({
      orderId: started.id, correlationId: 'corr-3', reason: CancellationReason.CUSTOMER_GAVE_UP,
    });

    const order = await ctx.uow.orders.findById(started.id);
    expect(order?.status).toBe(OrderStatus.CANCELLED);
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(false);
  });
});

describe('SAGA — varredura de pedidos vencidos', () => {
  let ctx: ReturnType<typeof setup>;
  let orderId: string;
  let chargeId: string;

  beforeEach(async () => {
    ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    orderId = started.id;
    chargeId = (await ctx.uow.orders.findById(orderId))!.paymentChargeId!;
  });

  it('compensa o pedido cuja janela venceu sem pagamento', async () => {
    ctx.clock.advanceMinutes(PAYMENT_WINDOW_MINUTES + 1);

    const result = await ctx.expireOrders.execute();

    expect(result).toMatchObject({ scanned: 1, compensated: 1, rescuedByReconciliation: 0 });
    expect((await ctx.uow.orders.findById(orderId))?.cancellationReason).toBe(
      CancellationReason.PAYMENT_TIMEOUT,
    );
    expect(ctx.vehicles.isReserved(VEHICLE)).toBe(false);
  });

  it('resgata a venda quando o cliente pagou e o webhook se perdeu', async () => {
    // O cliente pagou, mas a notificação nunca chegou.
    ctx.payments.simulatePayment(chargeId);
    ctx.clock.advanceMinutes(PAYMENT_WINDOW_MINUTES + 1);

    const result = await ctx.expireOrders.execute();

    expect(result.rescuedByReconciliation).toBe(1);
    expect(result.compensated).toBe(0);
    expect(ctx.vehicles.soldVehicles.has(VEHICLE)).toBe(true);
  });

  it('não toca em pedidos dentro do prazo', async () => {
    ctx.clock.advanceMinutes(PAYMENT_WINDOW_MINUTES - 5);
    expect(await ctx.expireOrders.execute()).toMatchObject({ scanned: 0, compensated: 0 });
  });
});

describe('SAGA — retomada via taskToken do Step Functions', () => {
  it('o webhook devolve o token em vez de conduzir o passo seguinte', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    // Simula o estado AguardarPagamento do Step Functions.
    await ctx.registerWaiter.execute({ orderId: started.id, taskToken: 'token-abc' });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });

    expect(ctx.callback.succeeded).toEqual([{ taskToken: 'token-abc' }]);
    // A baixa no estoque ficou para o estado ConfirmarVenda da máquina de estados.
    expect(ctx.vehicles.soldVehicles.has(VEHICLE)).toBe(false);
    expect((await ctx.uow.orders.findById(started.id))?.status).toBe(OrderStatus.PAID);
  });

  it('a desistência devolve o token com o erro ClienteDesistiu', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    await ctx.registerWaiter.execute({ orderId: started.id, taskToken: 'token-abc' });

    await ctx.cancelPurchase.execute({
      orderId: started.id, requestedBy: CUSTOMER_A, correlationId: 'corr-2',
    });

    expect(ctx.callback.failed[0]).toMatchObject({
      taskToken: 'token-abc',
      error: 'ClienteDesistiu',
    });
  });

  it('o token é consumido uma única vez, mesmo com webhooks concorrentes', async () => {
    const ctx = setup();
    const started = await ctx.startPurchase.execute({
      customerId: CUSTOMER_A, vehicleId: VEHICLE, correlationId: 'corr-1',
    });
    await ctx.registerWaiter.execute({ orderId: started.id, taskToken: 'token-abc' });
    const chargeId = (await ctx.uow.orders.findById(started.id))!.paymentChargeId!;

    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-2' });
    await ctx.confirmPayment.execute({ chargeId, outcome: 'PAID', correlationId: 'corr-3' });

    expect(ctx.callback.succeeded).toHaveLength(1);
  });
});

describe('Assinatura do webhook de pagamento', () => {
  it('aceita assinatura HMAC válida', () => {
    const gateway = new FakePaymentGateway(WEBHOOK_SECRET);
    const body = JSON.stringify({ eventId: 'evt-1', chargeId: 'chg-1', status: 'PAID' });

    expect(
      gateway.verifyWebhookSignature({ rawBody: body, signature: gateway.signPayload(body) }),
    ).toBe(true);
  });

  it('recusa assinatura de outro segredo', () => {
    const gateway = new FakePaymentGateway(WEBHOOK_SECRET);
    const impostor = new FakePaymentGateway('outro-segredo-qualquer');
    const body = JSON.stringify({ eventId: 'evt-1', chargeId: 'chg-1', status: 'PAID' });

    expect(
      gateway.verifyWebhookSignature({ rawBody: body, signature: impostor.signPayload(body) }),
    ).toBe(false);
  });

  it('recusa assinatura válida de um corpo diferente', () => {
    const gateway = new FakePaymentGateway(WEBHOOK_SECRET);
    const original = JSON.stringify({ eventId: 'evt-1', chargeId: 'chg-1', status: 'PAID' });
    const tampered = JSON.stringify({ eventId: 'evt-1', chargeId: 'chg-999', status: 'PAID' });

    expect(
      gateway.verifyWebhookSignature({
        rawBody: tampered,
        signature: gateway.signPayload(original),
      }),
    ).toBe(false);
  });
});
