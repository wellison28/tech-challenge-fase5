import { describe, expect, it } from 'vitest';
import {
  CancellationReason,
  Order,
  OrderStatus,
  SagaStep,
} from '../../../src/domain/entities/order';
import { ConflictError } from '../../../src/domain/errors/domain-error';

const NOW = new Date('2026-01-15T10:00:00.000Z');
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const VEHICLE = '22222222-2222-4222-8222-222222222222';

function buildOrder(): Order {
  return Order.create({ id: 'order-1', customerId: CUSTOMER, vehicleId: VEHICLE, now: NOW });
}

/** Leva o pedido até AWAITING_PAYMENT, como faria a SAGA no caminho feliz. */
function orderAwaitingPayment(windowMinutes = 25): Order {
  const order = buildOrder();
  order.markVehicleReserved({
    reservationId: 'res-1',
    amountInCents: 12_990_000,
    expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    now: NOW,
  });
  order.markCustomerValidated(NOW);
  order.markPaymentCodeIssued({
    chargeId: 'chg-1',
    paymentCode: '000201...',
    expiresAt: new Date(NOW.getTime() + windowMinutes * 60_000),
    now: NOW,
  });
  return order;
}

describe('Order — caminho feliz da SAGA', () => {
  it('percorre os passos até a venda confirmada', () => {
    const order = orderAwaitingPayment();
    expect(order.status).toBe(OrderStatus.AWAITING_PAYMENT);

    order.markPaid({ now: NOW, chargeId: 'chg-1' });
    expect(order.status).toBe(OrderStatus.PAID);

    order.markSaleConfirmed(NOW);
    expect(order.status).toBe(OrderStatus.SALE_CONFIRMED);

    order.markDelivered(NOW);
    expect(order.status).toBe(OrderStatus.COMPLETED);
    expect(order.isTerminal).toBe(true);
  });

  it('registra cada passo na linha do tempo', () => {
    const order = orderAwaitingPayment();
    expect(order.timeline.map((entry) => entry.step)).toEqual([
      SagaStep.RESERVE_VEHICLE,
      SagaStep.VALIDATE_CUSTOMER,
      SagaStep.CREATE_PAYMENT,
    ]);
    expect(order.timeline.every((entry) => entry.outcome === 'SUCCEEDED')).toBe(true);
  });

  it('congela o valor devolvido pela reserva', () => {
    expect(orderAwaitingPayment().amount?.cents).toBe(12_990_000);
  });
});

describe('Order — ordem dos passos', () => {
  it('recusa emitir cobrança antes de validar o comprador', () => {
    const order = buildOrder();
    order.markVehicleReserved({
      reservationId: 'res-1', amountInCents: 1000, expiresAt: NOW, now: NOW,
    });

    expect(() =>
      order.markPaymentCodeIssued({
        chargeId: 'chg-1', paymentCode: 'x', expiresAt: NOW, now: NOW,
      }),
    ).toThrow(ConflictError);
  });

  it('recusa confirmar venda antes do pagamento', () => {
    expect(() => orderAwaitingPayment().markSaleConfirmed(NOW)).toThrow(ConflictError);
  });

  it('recusa registrar retirada antes da baixa no estoque', () => {
    const order = orderAwaitingPayment();
    order.markPaid({ now: NOW });
    expect(() => order.markDelivered(NOW)).toThrow(ConflictError);
  });
});

describe('Order — idempotência dos passos', () => {
  it('reservar duas vezes com a mesma reserva não altera o pedido', () => {
    const order = buildOrder();
    const params = {
      reservationId: 'res-1',
      amountInCents: 12_990_000,
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      now: NOW,
    };
    order.markVehicleReserved(params);
    const version = order.version;

    order.markVehicleReserved(params);
    expect(order.version).toBe(version);
  });

  it('reservar com outra reserva sobre pedido já avançado é conflito', () => {
    const order = buildOrder();
    order.markVehicleReserved({
      reservationId: 'res-1', amountInCents: 1000, expiresAt: NOW, now: NOW,
    });

    expect(() =>
      order.markVehicleReserved({
        reservationId: 'res-2', amountInCents: 1000, expiresAt: NOW, now: NOW,
      }),
    ).toThrow(ConflictError);
  });

  it('webhook reentregue não muda nada', () => {
    const order = orderAwaitingPayment();
    order.markPaid({ now: NOW, chargeId: 'chg-1' });
    const version = order.version;

    order.markPaid({ now: NOW, chargeId: 'chg-1' });
    expect(order.version).toBe(version);
  });

  it('recusa webhook de uma cobrança que não é a do pedido', () => {
    const order = orderAwaitingPayment();
    expect(() => order.markPaid({ now: NOW, chargeId: 'chg-outro' })).toThrow(ConflictError);
  });
});

describe('Order — prazo de pagamento', () => {
  it('recusa pagamento confirmado após o prazo', () => {
    const order = orderAwaitingPayment(25);
    const tooLate = new Date(NOW.getTime() + 26 * 60_000);

    expect(order.isPaymentWindowExpired(tooLate)).toBe(true);
    expect(() => order.markPaid({ now: tooLate })).toThrow(ConflictError);
  });

  it('aceita pagamento dentro do prazo', () => {
    const order = orderAwaitingPayment(25);
    expect(() => order.markPaid({ now: new Date(NOW.getTime() + 24 * 60_000) })).not.toThrow();
  });
});

describe('Order — compensação', () => {
  it('lista as compensações necessárias na ordem inversa dos efeitos', () => {
    expect(orderAwaitingPayment().compensationsRequired()).toEqual([
      SagaStep.COMPENSATE_CANCEL_PAYMENT,
      SagaStep.COMPENSATE_RELEASE_VEHICLE,
    ]);
  });

  it('pedido apenas reservado só precisa liberar a reserva', () => {
    const order = buildOrder();
    order.markVehicleReserved({
      reservationId: 'res-1', amountInCents: 1000, expiresAt: NOW, now: NOW,
    });
    expect(order.compensationsRequired()).toEqual([SagaStep.COMPENSATE_RELEASE_VEHICLE]);
  });

  it('desistência do cliente termina em CANCELLED', () => {
    const order = orderAwaitingPayment();
    expect(order.beginCompensation(CancellationReason.CUSTOMER_GAVE_UP, null, NOW)).toBe(true);
    expect(order.status).toBe(OrderStatus.COMPENSATING);

    order.finishCompensation(NOW);
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  it('falha de sistema termina em FAILED — a distinção alimenta o alarme', () => {
    const order = orderAwaitingPayment();
    order.beginCompensation(CancellationReason.SYSTEM_FAILURE, 'timeout', NOW);
    order.finishCompensation(NOW);
    expect(order.status).toBe(OrderStatus.FAILED);
  });

  it('iniciar compensação é idempotente', () => {
    const order = orderAwaitingPayment();
    order.beginCompensation(CancellationReason.PAYMENT_TIMEOUT, null, NOW);
    expect(order.beginCompensation(CancellationReason.PAYMENT_TIMEOUT, null, NOW)).toBe(true);
  });

  it('pedido já encerrado não entra em compensação', () => {
    const order = orderAwaitingPayment();
    order.beginCompensation(CancellationReason.PAYMENT_TIMEOUT, null, NOW);
    order.finishCompensation(NOW);
    expect(order.beginCompensation(CancellationReason.CUSTOMER_GAVE_UP, null, NOW)).toBe(false);
  });

  it('pedido concluído não pode ser cancelado', () => {
    const order = orderAwaitingPayment();
    order.markPaid({ now: NOW });
    order.markSaleConfirmed(NOW);
    order.markDelivered(NOW);

    expect(order.beginCompensation(CancellationReason.CUSTOMER_GAVE_UP, null, NOW)).toBe(false);
  });

  it('venda confirmada não entra em compensação — a baixa é o ponto de não retorno', () => {
    const order = orderAwaitingPayment();
    order.markPaid({ now: NOW });
    order.markSaleConfirmed(NOW);

    expect(() => order.beginCompensation(CancellationReason.CUSTOMER_GAVE_UP, null, NOW)).toThrow(
      ConflictError,
    );
    expect(order.status).toBe(OrderStatus.SALE_CONFIRMED);
  });

  it('o cliente desiste até o pagamento; depois, não', () => {
    const awaiting = orderAwaitingPayment();
    expect(() => awaiting.assertCustomerCanGiveUp()).not.toThrow();

    awaiting.markPaid({ now: NOW });
    expect(() => awaiting.assertCustomerCanGiveUp()).toThrow(ConflictError);

    awaiting.markSaleConfirmed(NOW);
    expect(() => awaiting.assertCustomerCanGiveUp()).toThrow(ConflictError);
  });
});

describe('Order — token de callback do Step Functions', () => {
  it('só aceita token com o pedido aguardando pagamento', () => {
    const order = buildOrder();
    expect(() => order.attachSagaTaskToken('token-1', NOW)).toThrow(ConflictError);
  });

  it('consome o token uma única vez', () => {
    const order = orderAwaitingPayment();
    order.attachSagaTaskToken('token-1', NOW);

    expect(order.consumeSagaTaskToken(NOW)).toBe('token-1');
    expect(order.consumeSagaTaskToken(NOW)).toBeNull();
  });

  it('encerrar a compensação invalida o token pendente', () => {
    const order = orderAwaitingPayment();
    order.attachSagaTaskToken('token-1', NOW);
    order.beginCompensation(CancellationReason.PAYMENT_TIMEOUT, null, NOW);
    order.finishCompensation(NOW);

    expect(order.sagaTaskToken).toBeNull();
  });
});
