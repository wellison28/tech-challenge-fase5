import { beforeEach, describe, expect, it } from 'vitest';
import {
  FuelType,
  Transmission,
  Vehicle,
  VehicleStatus,
} from '../../../src/domain/entities/vehicle';
import { ConflictError, ValidationError } from '../../../src/domain/errors/domain-error';

const NOW = new Date('2026-01-15T10:00:00.000Z');

function buildVehicle(overrides: Partial<Parameters<typeof Vehicle.create>[0]> = {}): Vehicle {
  return Vehicle.create({
    id: 'veh-1',
    vin: '9BWZZZ377VT004251',
    licensePlate: 'ABC1D23',
    brand: 'Volkswagen',
    model: 'Nivus Highline',
    modelYear: 2024,
    manufactureYear: 2023,
    color: 'Prata',
    mileageKm: 18_500,
    fuelType: FuelType.FLEX,
    transmission: Transmission.AUTOMATIC,
    priceInCents: 12_990_000,
    now: NOW,
    ...overrides,
  });
}

describe('Vehicle — criação', () => {
  it('nasce disponível para venda', () => {
    const vehicle = buildVehicle();
    expect(vehicle.status).toBe(VehicleStatus.AVAILABLE);
    expect(vehicle.reservation).toBeNull();
    expect(vehicle.version).toBe(1);
  });

  it('recusa ano-modelo anterior ao de fabricação', () => {
    expect(() => buildVehicle({ modelYear: 2022, manufactureYear: 2023 })).toThrow(ValidationError);
  });

  it('recusa ano-modelo mais de um ano à frente da fabricação', () => {
    expect(() => buildVehicle({ modelYear: 2025, manufactureYear: 2023 })).toThrow(ValidationError);
  });

  it('recusa quilometragem negativa', () => {
    expect(() => buildVehicle({ mileageKm: -1 })).toThrow(ValidationError);
  });

  it('recusa marca em branco', () => {
    expect(() => buildVehicle({ brand: '   ' })).toThrow(ValidationError);
  });

  it('aceita veículo sem placa (0 km ainda não emplacado)', () => {
    expect(buildVehicle({ licensePlate: null, mileageKm: 0 }).licensePlate).toBeNull();
  });
});

describe('Vehicle — edição', () => {
  it('atualiza o preço e incrementa a versão', () => {
    const vehicle = buildVehicle();
    vehicle.update({ priceInCents: 11_500_000, now: NOW });
    expect(vehicle.price.cents).toBe(11_500_000);
    expect(vehicle.version).toBe(2);
  });

  it('permite editar um veículo reservado (a reserva não congela o cadastro)', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    expect(() => vehicle.update({ color: 'Preto', now: NOW })).not.toThrow();
  });

  it('bloqueia a edição de um veículo vendido', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW });
    expect(() => vehicle.update({ priceInCents: 1_000, now: NOW })).toThrow(ConflictError);
  });
});

describe('Vehicle — reserva', () => {
  let vehicle: Vehicle;

  beforeEach(() => {
    vehicle = buildVehicle();
  });

  it('bloqueia a unidade e define o prazo de validade', () => {
    const reservation = vehicle.reserve({
      reservationId: 'r1',
      customerId: 'c1',
      orderId: 'o1',
      ttlMinutes: 30,
      now: NOW,
    });

    expect(vehicle.status).toBe(VehicleStatus.RESERVED);
    expect(reservation.expiresAt.toISOString()).toBe('2026-01-15T10:30:00.000Z');
  });

  it('é idempotente para o mesmo pedido', () => {
    const first = vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    const second = vehicle.reserve({ reservationId: 'r2', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    expect(second.id).toBe(first.id);
  });

  it('recusa reserva concorrente de outro pedido', () => {
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    expect(() =>
      vehicle.reserve({ reservationId: 'r2', customerId: 'c2', orderId: 'o2', ttlMinutes: 30, now: NOW }),
    ).toThrow(ConflictError);
  });

  it('permite nova reserva depois que a anterior vence', () => {
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    const later = new Date(NOW.getTime() + 31 * 60_000);

    expect(vehicle.hasExpiredReservation(later)).toBe(true);
    const reservation = vehicle.reserve({
      reservationId: 'r2', customerId: 'c2', orderId: 'o2', ttlMinutes: 30, now: later,
    });
    expect(reservation.customerId).toBe('c2');
  });

  it('recusa reserva de veículo já vendido', () => {
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW });
    expect(() =>
      vehicle.reserve({ reservationId: 'r2', customerId: 'c2', orderId: 'o2', ttlMinutes: 30, now: NOW }),
    ).toThrow(ConflictError);
  });
});

describe('Vehicle — liberação da reserva (compensação)', () => {
  it('devolve o veículo ao estoque', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });

    expect(vehicle.releaseReservation({ reservationId: 'r1', now: NOW })).toBe(true);
    expect(vehicle.status).toBe(VehicleStatus.AVAILABLE);
  });

  it('é idempotente quando não há reserva ativa', () => {
    expect(buildVehicle().releaseReservation({ now: NOW })).toBe(false);
  });

  it('recusa liberar informando uma reserva que não é a ativa', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    expect(() => vehicle.releaseReservation({ reservationId: 'outra', now: NOW })).toThrow(ConflictError);
  });
});

describe('Vehicle — confirmação da venda', () => {
  it('dá baixa no estoque congelando o preço praticado', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW });

    expect(vehicle.status).toBe(VehicleStatus.SOLD);
    expect(vehicle.sale?.soldPrice.cents).toBe(12_990_000);
    expect(vehicle.reservation).toBeNull();
  });

  it('exige reserva ativa', () => {
    expect(() => buildVehicle().confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW })).toThrow(
      ConflictError,
    );
  });

  it('recusa confirmação de um pedido diferente da reserva', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    expect(() => vehicle.confirmSale({ orderId: 'o2', customerId: 'c1', now: NOW })).toThrow(ConflictError);
  });

  it('recusa confirmação por comprador diferente do titular da reserva', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    expect(() => vehicle.confirmSale({ orderId: 'o1', customerId: 'c2', now: NOW })).toThrow(ConflictError);
  });

  it('recusa pagamento confirmado após a expiração da reserva', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    const tooLate = new Date(NOW.getTime() + 31 * 60_000);
    expect(() => vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: tooLate })).toThrow(
      ConflictError,
    );
  });

  it('é idempotente para o mesmo pedido', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW });
    const versionAfterSale = vehicle.version;

    vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW });
    expect(vehicle.version).toBe(versionAfterSale);
  });

  it('recusa vender um veículo já vendido em outro pedido', () => {
    const vehicle = buildVehicle();
    vehicle.reserve({ reservationId: 'r1', customerId: 'c1', orderId: 'o1', ttlMinutes: 30, now: NOW });
    vehicle.confirmSale({ orderId: 'o1', customerId: 'c1', now: NOW });
    expect(() => vehicle.confirmSale({ orderId: 'o2', customerId: 'c2', now: NOW })).toThrow(ConflictError);
  });
});
