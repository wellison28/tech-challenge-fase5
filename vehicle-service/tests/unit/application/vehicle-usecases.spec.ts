import { beforeEach, describe, expect, it } from 'vitest';
import { EventFactory } from '../../../src/application/events/event-factory';
import { ConfirmVehicleSaleUseCase } from '../../../src/application/usecases/confirm-vehicle-sale';
import { ExpireReservationsUseCase } from '../../../src/application/usecases/expire-reservations';
import { ListVehiclesUseCase } from '../../../src/application/usecases/list-vehicles';
import { PublishOutboxUseCase } from '../../../src/application/usecases/publish-outbox';
import { RegisterVehicleUseCase } from '../../../src/application/usecases/register-vehicle';
import { ReleaseReservationUseCase } from '../../../src/application/usecases/release-reservation';
import { ReserveVehicleUseCase } from '../../../src/application/usecases/reserve-vehicle';
import { UpdateVehicleUseCase } from '../../../src/application/usecases/update-vehicle';
import { FuelType, Transmission } from '../../../src/domain/entities/vehicle';
import {
  ConflictError,
  DuplicateResourceError,
  NotFoundError,
} from '../../../src/domain/errors/domain-error';
import { VehicleEventType } from '../../../src/domain/events/domain-event';
import {
  FakeClock,
  RecordingEventPublisher,
  SequentialIdGenerator,
} from '../../support/fakes';
import { InMemoryUnitOfWork } from '../../support/in-memory-unit-of-work';

const CUSTOMER_A = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_B = '22222222-2222-4222-8222-222222222222';
const ORDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TTL_MINUTES = 30;

function setup() {
  const uow = new InMemoryUnitOfWork();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator();
  const events = new EventFactory(ids, clock);

  return {
    uow,
    clock,
    ids,
    register: new RegisterVehicleUseCase(uow, ids, clock, events),
    update: new UpdateVehicleUseCase(uow, clock, events),
    list: new ListVehiclesUseCase(uow),
    reserve: new ReserveVehicleUseCase(uow, ids, clock, events, TTL_MINUTES),
    release: new ReleaseReservationUseCase(uow, clock, events),
    confirmSale: new ConfirmVehicleSaleUseCase(uow, clock, events),
    expire: new ExpireReservationsUseCase(uow, clock, events),
  };
}

function vehiclePayload(overrides: Record<string, unknown> = {}) {
  return {
    vin: '9BWZZZ377VT004251',
    licensePlate: 'ABC1D23',
    brand: 'Volkswagen',
    model: 'Nivus',
    modelYear: 2024,
    manufactureYear: 2023,
    color: 'Prata',
    mileageKm: 18_500,
    fuelType: FuelType.FLEX,
    transmission: Transmission.AUTOMATIC,
    priceInCents: 12_990_000,
    correlationId: 'corr-1',
    ...overrides,
  } as Parameters<RegisterVehicleUseCase['execute']>[0];
}

describe('RegisterVehicleUseCase', () => {
  it('cadastra o veículo e enfileira o evento no outbox', async () => {
    const { register, uow } = setup();

    const vehicle = await register.execute(vehiclePayload());

    expect(vehicle.status).toBe('AVAILABLE');
    expect(vehicle.priceFormatted).toContain('129.900,00');
    expect(uow.outbox.eventTypes()).toEqual([VehicleEventType.REGISTERED]);
  });

  it('recusa chassi duplicado', async () => {
    const { register } = setup();
    await register.execute(vehiclePayload());

    await expect(register.execute(vehiclePayload({ licensePlate: 'XYZ9876' }))).rejects.toThrow(
      DuplicateResourceError,
    );
  });

  it('recusa placa duplicada em outro veículo', async () => {
    const { register } = setup();
    await register.execute(vehiclePayload());

    await expect(register.execute(vehiclePayload({ vin: '9BWZZZ377VT009999' }))).rejects.toThrow(
      DuplicateResourceError,
    );
  });
});

describe('UpdateVehicleUseCase', () => {
  it('atualiza o preço e publica evento de atualização', async () => {
    const { register, update, uow } = setup();
    const created = await register.execute(vehiclePayload());

    const updated = await update.execute({
      vehicleId: created.id,
      priceInCents: 11_900_000,
      correlationId: 'corr-2',
    });

    expect(updated.priceInCents).toBe(11_900_000);
    expect(uow.outbox.eventTypes()).toContain(VehicleEventType.UPDATED);
  });

  it('falha quando o veículo não existe', async () => {
    const { update } = setup();
    await expect(
      update.execute({ vehicleId: 'inexistente', color: 'Preto', correlationId: 'c' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejeita escrita com versão desatualizada (If-Match)', async () => {
    const { register, update } = setup();
    const created = await register.execute(vehiclePayload());

    await expect(
      update.execute({ vehicleId: created.id, color: 'Preto', expectedVersion: 99, correlationId: 'c' }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('ListVehiclesUseCase', () => {
  it('lista veículos à venda do mais barato para o mais caro', async () => {
    const { register, list } = setup();
    await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000001', licensePlate: 'AAA1A11', priceInCents: 9_000_000 }));
    await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000002', licensePlate: 'BBB2B22', priceInCents: 4_500_000 }));
    await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000003', licensePlate: 'CCC3C33', priceInCents: 15_000_000 }));

    const page = await list.listAvailable({});

    expect(page.items.map((item) => item.priceInCents)).toEqual([4_500_000, 9_000_000, 15_000_000]);
    expect(page.total).toBe(3);
  });

  it('lista vendidos do mais barato para o mais caro e exclui os disponíveis', async () => {
    const { register, reserve, confirmSale, list } = setup();
    const cheap = await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000001', licensePlate: 'AAA1A11', priceInCents: 4_000_000 }));
    const pricey = await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000002', licensePlate: 'BBB2B22', priceInCents: 8_000_000 }));
    await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000003', licensePlate: 'CCC3C33', priceInCents: 1_000_000 }));

    for (const [vehicle, orderId] of [[pricey, ORDER_A], [cheap, ORDER_B]] as const) {
      await reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId, correlationId: 'c' });
      await confirmSale.execute({ vehicleId: vehicle.id, orderId, customerId: CUSTOMER_A, correlationId: 'c' });
    }

    const sold = await list.listSold({});
    expect(sold.items.map((item) => item.priceInCents)).toEqual([4_000_000, 8_000_000]);
  });

  it('o catálogo público só mostra a placa de veículo à venda', async () => {
    const { register, reserve, confirmSale, list } = setup();
    const sold = await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000001', licensePlate: 'AAA1A11' }));
    const reserved = await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000002', licensePlate: 'BBB2B22' }));
    await register.execute(vehiclePayload({ vin: '9BWZZZ377VT000003', licensePlate: 'CCC3C33' }));

    await reserve.execute({ vehicleId: sold.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });
    await confirmSale.execute({ vehicleId: sold.id, orderId: ORDER_A, customerId: CUSTOMER_A, correlationId: 'c' });
    await reserve.execute({ vehicleId: reserved.id, customerId: CUSTOMER_B, orderId: ORDER_B, correlationId: 'c' });

    const all = await list.execute({});
    const plateOf = (id: string) => all.items.find((item) => item.id === id)?.licensePlate;

    expect(plateOf(sold.id)).toBeNull();
    expect(plateOf(reserved.id)).toBeNull();
    expect((await list.listAvailable({})).items[0]?.licensePlate).toBe('CCC3C33');
    expect((await list.listSold({})).items[0]?.licensePlate).toBeNull();
  });

  it('pagina mantendo a ordenação', async () => {
    const { register, list } = setup();
    for (let i = 1; i <= 5; i += 1) {
      await register.execute(
        vehiclePayload({
          vin: `9BWZZZ377VT00000${i}`,
          licensePlate: `ABC${i}D0${i}`,
          priceInCents: i * 1_000_000,
        }),
      );
    }

    const page2 = await list.listAvailable({ page: 2, pageSize: 2 });
    expect(page2.items.map((item) => item.priceInCents)).toEqual([3_000_000, 4_000_000]);
    expect(page2.totalPages).toBe(3);
  });
});

describe('ReserveVehicleUseCase — disputa de estoque', () => {
  let ctx: ReturnType<typeof setup>;
  let vehicleId: string;

  beforeEach(async () => {
    ctx = setup();
    vehicleId = (await ctx.register.execute(vehiclePayload())).id;
  });

  it('reserva o veículo e publica vehicle.reserved', async () => {
    const result = await ctx.reserve.execute({
      vehicleId, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c',
    });

    expect(result.alreadyReserved).toBe(false);
    expect(result.expiresAt).toBe('2026-01-15T10:30:00.000Z');
    expect(ctx.uow.outbox.eventTypes()).toContain(VehicleEventType.RESERVED);
  });

  it('o segundo cliente recebe conflito — requisito do enunciado', async () => {
    await ctx.reserve.execute({ vehicleId, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    await expect(
      ctx.reserve.execute({ vehicleId, customerId: CUSTOMER_B, orderId: ORDER_B, correlationId: 'c' }),
    ).rejects.toThrow(ConflictError);
  });

  it('reexecutar o passo da SAGA não cria uma segunda reserva', async () => {
    const first = await ctx.reserve.execute({ vehicleId, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });
    const retry = await ctx.reserve.execute({ vehicleId, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    expect(retry.reservationId).toBe(first.reservationId);
    expect(retry.alreadyReserved).toBe(true);
    expect(ctx.uow.outbox.eventTypes().filter((t) => t === VehicleEventType.RESERVED)).toHaveLength(1);
  });

  it('reserva vencida é substituída por uma nova de outro cliente', async () => {
    await ctx.reserve.execute({ vehicleId, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });
    ctx.clock.advanceMinutes(TTL_MINUTES + 1);

    const result = await ctx.reserve.execute({
      vehicleId, customerId: CUSTOMER_B, orderId: ORDER_B, correlationId: 'c',
    });
    expect(result.alreadyReserved).toBe(false);
  });

  it('perde a corrida quando outra transação grava entre o SELECT e o UPDATE', async () => {
    // Simula a escrita concorrente: outro pedido grava entre o SELECT e o UPDATE
    // deste caso de uso, fazendo a trava otimista rejeitar a escrita.
    ctx.uow.vehicles.failNextUpdate = true;

    await expect(
      ctx.reserve.execute({ vehicleId, customerId: CUSTOMER_B, orderId: ORDER_B, correlationId: 'c' }),
    ).rejects.toThrow(ConflictError);
  });

  it('falha para veículo inexistente', async () => {
    await expect(
      ctx.reserve.execute({ vehicleId: 'nada', customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('ReleaseReservationUseCase — compensação', () => {
  it('devolve o veículo ao estoque e publica o evento', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    const result = await ctx.release.execute({
      vehicleId: vehicle.id, orderId: ORDER_A, reason: 'PAYMENT_FAILED', correlationId: 'c',
    });

    expect(result.released).toBe(true);
    expect(ctx.uow.outbox.eventTypes()).toContain(VehicleEventType.RESERVATION_RELEASED);
    expect((await ctx.list.listAvailable({})).total).toBe(1);
  });

  it('é idempotente: liberar duas vezes não gera segundo evento', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });
    await ctx.release.execute({ vehicleId: vehicle.id, orderId: ORDER_A, reason: 'CUSTOMER_GAVE_UP', correlationId: 'c' });

    const second = await ctx.release.execute({
      vehicleId: vehicle.id, orderId: ORDER_A, reason: 'CUSTOMER_GAVE_UP', correlationId: 'c',
    });

    expect(second.released).toBe(false);
    expect(
      ctx.uow.outbox.eventTypes().filter((t) => t === VehicleEventType.RESERVATION_RELEASED),
    ).toHaveLength(1);
  });

  it('não libera reserva pertencente a outro pedido', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    const result = await ctx.release.execute({
      vehicleId: vehicle.id, orderId: ORDER_B, reason: 'SAGA_COMPENSATION', correlationId: 'c',
    });
    expect(result.released).toBe(false);
  });
});

describe('ConfirmVehicleSaleUseCase', () => {
  it('conclui a venda e publica vehicle.sold', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    const sold = await ctx.confirmSale.execute({
      vehicleId: vehicle.id, orderId: ORDER_A, customerId: CUSTOMER_A, correlationId: 'c',
    });

    expect(sold.status).toBe('SOLD');
    expect(sold.sale?.soldPriceInCents).toBe(12_990_000);
    expect(ctx.uow.outbox.eventTypes()).toContain(VehicleEventType.SOLD);
  });

  it('recusa confirmação após a expiração da reserva', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });
    ctx.clock.advanceMinutes(TTL_MINUTES + 1);

    await expect(
      ctx.confirmSale.execute({ vehicleId: vehicle.id, orderId: ORDER_A, customerId: CUSTOMER_A, correlationId: 'c' }),
    ).rejects.toThrow(ConflictError);
  });

  it('é idempotente e não duplica o evento de venda', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });
    const command = { vehicleId: vehicle.id, orderId: ORDER_A, customerId: CUSTOMER_A, correlationId: 'c' };

    await ctx.confirmSale.execute(command);
    await ctx.confirmSale.execute(command);

    expect(ctx.uow.outbox.eventTypes().filter((t) => t === VehicleEventType.SOLD)).toHaveLength(1);
  });
});

describe('ExpireReservationsUseCase', () => {
  it('devolve ao estoque as reservas vencidas', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    ctx.clock.advanceMinutes(TTL_MINUTES + 1);
    const result = await ctx.expire.execute();

    expect(result).toEqual({ scanned: 1, released: 1, skippedByConcurrency: 0 });
    expect(ctx.uow.outbox.eventTypes()).toContain(VehicleEventType.RESERVATION_EXPIRED);
    expect((await ctx.list.listAvailable({})).total).toBe(1);
  });

  it('não toca em reservas ainda vigentes', async () => {
    const ctx = setup();
    const vehicle = await ctx.register.execute(vehiclePayload());
    await ctx.reserve.execute({ vehicleId: vehicle.id, customerId: CUSTOMER_A, orderId: ORDER_A, correlationId: 'c' });

    ctx.clock.advanceMinutes(TTL_MINUTES - 5);
    expect(await ctx.expire.execute()).toEqual({ scanned: 0, released: 0, skippedByConcurrency: 0 });
  });
});

describe('PublishOutboxUseCase', () => {
  it('publica os eventos pendentes e os marca como entregues', async () => {
    const ctx = setup();
    const publisher = new RecordingEventPublisher();
    const publishOutbox = new PublishOutboxUseCase(ctx.uow, publisher, ctx.clock);
    await ctx.register.execute(vehiclePayload());

    const result = await publishOutbox.execute();

    expect(result).toEqual({ fetched: 1, published: 1, failed: 0 });
    expect(publisher.published[0]?.eventType).toBe(VehicleEventType.REGISTERED);
    expect(await publishOutbox.execute()).toEqual({ fetched: 0, published: 0, failed: 0 });
  });

  it('mantém o evento pendente e conta a tentativa quando o barramento falha', async () => {
    const ctx = setup();
    const publisher = new RecordingEventPublisher();
    publisher.shouldFail = true;
    const publishOutbox = new PublishOutboxUseCase(ctx.uow, publisher, ctx.clock);
    await ctx.register.execute(vehiclePayload());

    const result = await publishOutbox.execute();

    expect(result.failed).toBe(1);
    expect(ctx.uow.outbox.records[0]?.publishedAt).toBeNull();
    expect(ctx.uow.outbox.records[0]?.attempts).toBe(1);
  });
});
