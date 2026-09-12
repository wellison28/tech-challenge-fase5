import { ConflictError, ValidationError } from '../errors/domain-error';
import { LicensePlate } from '../value-objects/license-plate';
import { Money } from '../value-objects/money';
import { Vin } from '../value-objects/vin';

/**
 * Ciclo de vida da unidade em estoque.
 *
 *   AVAILABLE ──reserve()──▶ RESERVED ──confirmSale()──▶ SOLD (terminal)
 *       ▲                        │
 *       └──releaseReservation()──┘
 *
 * O estado RESERVED existe porque o processo de compra não é atômico: entre a
 * escolha do veículo e a confirmação do pagamento existe uma janela na qual a
 * unidade precisa ficar bloqueada para um único comprador. É esse estado que
 * torna possível a compensação da SAGA (liberar a reserva) quando o pagamento
 * não se confirma ou o cliente desiste.
 */
export const VehicleStatus = {
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  SOLD: 'SOLD',
} as const;
export type VehicleStatus = (typeof VehicleStatus)[keyof typeof VehicleStatus];

export const FuelType = {
  FLEX: 'FLEX',
  GASOLINE: 'GASOLINE',
  ETHANOL: 'ETHANOL',
  DIESEL: 'DIESEL',
  ELECTRIC: 'ELECTRIC',
  HYBRID: 'HYBRID',
} as const;
export type FuelType = (typeof FuelType)[keyof typeof FuelType];

export const Transmission = {
  MANUAL: 'MANUAL',
  AUTOMATIC: 'AUTOMATIC',
  CVT: 'CVT',
  AUTOMATED: 'AUTOMATED',
} as const;
export type Transmission = (typeof Transmission)[keyof typeof Transmission];

export interface Reservation {
  /** Identificador da reserva; é o handle usado pela compensação da SAGA. */
  readonly id: string;
  /** Cliente para quem a unidade está bloqueada. */
  readonly customerId: string;
  /** Pedido (SAGA) que originou a reserva — garante idempotência do passo. */
  readonly orderId: string;
  readonly reservedAt: Date;
  /** Depois deste instante a reserva perde validade e o veículo volta ao estoque. */
  readonly expiresAt: Date;
}

export interface SaleRecord {
  readonly orderId: string;
  readonly customerId: string;
  readonly soldAt: Date;
  /** Preço efetivamente praticado, congelado no momento da venda. */
  readonly soldPrice: Money;
}

export interface VehicleProps {
  id: string;
  vin: Vin;
  licensePlate: LicensePlate | null;
  brand: string;
  model: string;
  modelYear: number;
  manufactureYear: number;
  color: string;
  mileageKm: number;
  fuelType: FuelType;
  transmission: Transmission;
  price: Money;
  status: VehicleStatus;
  reservation: Reservation | null;
  sale: SaleRecord | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVehicleInput {
  id: string;
  vin: string;
  licensePlate?: string | null;
  brand: string;
  model: string;
  modelYear: number;
  manufactureYear: number;
  color: string;
  mileageKm: number;
  fuelType: FuelType;
  transmission: Transmission;
  priceInCents: number;
  now?: Date;
}

export interface UpdateVehicleInput {
  licensePlate?: string | null;
  brand?: string;
  model?: string;
  modelYear?: number;
  manufactureYear?: number;
  color?: string;
  mileageKm?: number;
  fuelType?: FuelType;
  transmission?: Transmission;
  priceInCents?: number;
  now?: Date;
}

const MIN_MODEL_YEAR = 1900;
/** Montadoras lançam o ano-modelo seguinte ainda no ano corrente. */
const MAX_YEARS_AHEAD = 1;
const MAX_MILEAGE_KM = 2_000_000;

export class Vehicle {
  private constructor(private props: VehicleProps) {}

  // ---------------------------------------------------------------------------
  // Construção
  // ---------------------------------------------------------------------------

  static create(input: CreateVehicleInput): Vehicle {
    const now = input.now ?? new Date();
    const brand = Vehicle.assertText(input.brand, 'marca', 60);
    const model = Vehicle.assertText(input.model, 'modelo', 80);
    const color = Vehicle.assertText(input.color, 'cor', 40);

    Vehicle.assertYears(input.modelYear, input.manufactureYear, now);
    Vehicle.assertMileage(input.mileageKm);

    return new Vehicle({
      id: input.id,
      vin: Vin.create(input.vin),
      licensePlate: input.licensePlate ? LicensePlate.create(input.licensePlate) : null,
      brand,
      model,
      modelYear: input.modelYear,
      manufactureYear: input.manufactureYear,
      color,
      mileageKm: input.mileageKm,
      fuelType: input.fuelType,
      transmission: input.transmission,
      price: Money.fromCents(input.priceInCents),
      status: VehicleStatus.AVAILABLE,
      reservation: null,
      sale: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Reidrata a entidade a partir do repositório, sem reexecutar regras de criação. */
  static restore(props: VehicleProps): Vehicle {
    return new Vehicle({ ...props });
  }

  // ---------------------------------------------------------------------------
  // Comportamento
  // ---------------------------------------------------------------------------

  /**
   * Edição cadastral. Um veículo já vendido é registro histórico: alterá-lo
   * reescreveria o passado contábil da revenda, por isso a operação é bloqueada.
   */
  update(input: UpdateVehicleInput): void {
    const now = input.now ?? new Date();

    if (this.props.status === VehicleStatus.SOLD) {
      throw new ConflictError('Não é permitido editar um veículo já vendido', {
        vehicleId: this.props.id,
      });
    }

    const modelYear = input.modelYear ?? this.props.modelYear;
    const manufactureYear = input.manufactureYear ?? this.props.manufactureYear;
    if (input.modelYear !== undefined || input.manufactureYear !== undefined) {
      Vehicle.assertYears(modelYear, manufactureYear, now);
    }
    if (input.mileageKm !== undefined) {
      Vehicle.assertMileage(input.mileageKm);
    }

    if (input.licensePlate !== undefined) {
      this.props.licensePlate = input.licensePlate ? LicensePlate.create(input.licensePlate) : null;
    }
    if (input.brand !== undefined) this.props.brand = Vehicle.assertText(input.brand, 'marca', 60);
    if (input.model !== undefined) this.props.model = Vehicle.assertText(input.model, 'modelo', 80);
    if (input.color !== undefined) this.props.color = Vehicle.assertText(input.color, 'cor', 40);
    if (input.mileageKm !== undefined) this.props.mileageKm = input.mileageKm;
    if (input.fuelType !== undefined) this.props.fuelType = input.fuelType;
    if (input.transmission !== undefined) this.props.transmission = input.transmission;
    if (input.priceInCents !== undefined) this.props.price = Money.fromCents(input.priceInCents);
    this.props.modelYear = modelYear;
    this.props.manufactureYear = manufactureYear;

    this.touch(now);
  }

  /**
   * Bloqueia a unidade para um comprador.
   *
   * Reservar o mesmo pedido duas vezes é permitido e não gera efeito (idempotência):
   * a SAGA pode reexecutar este passo após um timeout de rede sem provocar erro.
   * Reservar para um pedido diferente enquanto há reserva ativa é conflito — é
   * exatamente o cenário "outro cliente reservou o veículo antes".
   */
  reserve(params: {
    reservationId: string;
    customerId: string;
    orderId: string;
    ttlMinutes: number;
    now?: Date;
  }): Reservation {
    const now = params.now ?? new Date();

    if (this.props.status === VehicleStatus.SOLD) {
      throw new ConflictError('Veículo já vendido e indisponível para reserva', {
        vehicleId: this.props.id,
      });
    }

    const current = this.props.reservation;
    if (current && !Vehicle.isExpired(current, now)) {
      if (current.orderId === params.orderId) {
        return current; // idempotente: mesma SAGA, mesma reserva
      }
      throw new ConflictError('Veículo já reservado para outro pedido', {
        vehicleId: this.props.id,
        reservedUntil: current.expiresAt.toISOString(),
      });
    }

    if (params.ttlMinutes <= 0) {
      throw new ValidationError('O prazo de validade da reserva deve ser positivo', {
        ttlMinutes: params.ttlMinutes,
      });
    }

    const reservation: Reservation = {
      id: params.reservationId,
      customerId: params.customerId,
      orderId: params.orderId,
      reservedAt: now,
      expiresAt: new Date(now.getTime() + params.ttlMinutes * 60_000),
    };

    this.props.reservation = reservation;
    this.props.status = VehicleStatus.RESERVED;
    this.touch(now);
    return reservation;
  }

  /**
   * Compensação do passo de reserva: devolve a unidade ao estoque.
   * É idempotente — liberar um veículo já disponível não é erro, porque a SAGA
   * pode reexecutar a compensação.
   */
  releaseReservation(params: { reservationId?: string; now?: Date } = {}): boolean {
    const now = params.now ?? new Date();

    if (this.props.status === VehicleStatus.SOLD) {
      throw new ConflictError('Não é possível liberar a reserva de um veículo vendido', {
        vehicleId: this.props.id,
      });
    }
    if (!this.props.reservation) {
      return false;
    }
    if (params.reservationId && this.props.reservation.id !== params.reservationId) {
      throw new ConflictError('A reserva informada não corresponde à reserva ativa do veículo', {
        vehicleId: this.props.id,
      });
    }

    this.props.reservation = null;
    this.props.status = VehicleStatus.AVAILABLE;
    this.touch(now);
    return true;
  }

  /**
   * Baixa no estoque. Só é aceita a partir de uma reserva ativa do mesmo pedido:
   * impede que uma confirmação de pagamento atrasada venda um veículo que já
   * voltou ao estoque e foi reservado por outro comprador.
   */
  confirmSale(params: { orderId: string; customerId: string; now?: Date }): void {
    const now = params.now ?? new Date();

    if (this.props.status === VehicleStatus.SOLD) {
      if (this.props.sale?.orderId === params.orderId) {
        return; // idempotente
      }
      throw new ConflictError('Veículo já vendido em outro pedido', {
        vehicleId: this.props.id,
        orderId: this.props.sale?.orderId,
      });
    }

    const reservation = this.props.reservation;
    if (!reservation) {
      throw new ConflictError('Não há reserva ativa para confirmar a venda', {
        vehicleId: this.props.id,
      });
    }
    if (reservation.orderId !== params.orderId) {
      throw new ConflictError('A reserva ativa pertence a outro pedido', {
        vehicleId: this.props.id,
      });
    }
    if (reservation.customerId !== params.customerId) {
      throw new ConflictError('O comprador informado não corresponde ao titular da reserva', {
        vehicleId: this.props.id,
      });
    }
    if (Vehicle.isExpired(reservation, now)) {
      throw new ConflictError('A reserva expirou antes da confirmação do pagamento', {
        vehicleId: this.props.id,
        expiresAt: reservation.expiresAt.toISOString(),
      });
    }

    this.props.sale = {
      orderId: params.orderId,
      customerId: params.customerId,
      soldAt: now,
      soldPrice: this.props.price,
    };
    this.props.status = VehicleStatus.SOLD;
    this.props.reservation = null;
    this.touch(now);
  }

  /** Usado pelo expirador de reservas para saber se a unidade deve voltar ao estoque. */
  hasExpiredReservation(now: Date = new Date()): boolean {
    return this.props.reservation !== null && Vehicle.isExpired(this.props.reservation, now);
  }

  // ---------------------------------------------------------------------------
  // Acessores
  // ---------------------------------------------------------------------------

  get id(): string { return this.props.id; }
  get vin(): Vin { return this.props.vin; }
  get licensePlate(): LicensePlate | null { return this.props.licensePlate; }
  get brand(): string { return this.props.brand; }
  get model(): string { return this.props.model; }
  get modelYear(): number { return this.props.modelYear; }
  get manufactureYear(): number { return this.props.manufactureYear; }
  get color(): string { return this.props.color; }
  get mileageKm(): number { return this.props.mileageKm; }
  get fuelType(): FuelType { return this.props.fuelType; }
  get transmission(): Transmission { return this.props.transmission; }
  get price(): Money { return this.props.price; }
  get status(): VehicleStatus { return this.props.status; }
  get reservation(): Reservation | null { return this.props.reservation; }
  get sale(): SaleRecord | null { return this.props.sale; }
  get version(): number { return this.props.version; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  toSnapshot(): VehicleProps {
    return { ...this.props };
  }

  // ---------------------------------------------------------------------------
  // Invariantes
  // ---------------------------------------------------------------------------

  private touch(now: Date): void {
    this.props.updatedAt = now;
    this.props.version += 1;
  }

  private static isExpired(reservation: Reservation, now: Date): boolean {
    return reservation.expiresAt.getTime() <= now.getTime();
  }

  private static assertText(value: string, field: string, maxLength: number): string {
    const normalized = value?.trim() ?? '';
    if (normalized.length === 0) {
      throw new ValidationError(`O campo "${field}" é obrigatório`, { field });
    }
    if (normalized.length > maxLength) {
      throw new ValidationError(`O campo "${field}" excede ${maxLength} caracteres`, { field });
    }
    return normalized;
  }

  private static assertYears(modelYear: number, manufactureYear: number, now: Date): void {
    const maxYear = now.getFullYear() + MAX_YEARS_AHEAD;
    for (const [field, year] of [
      ['ano-modelo', modelYear],
      ['ano de fabricação', manufactureYear],
    ] as const) {
      if (!Number.isInteger(year) || year < MIN_MODEL_YEAR || year > maxYear) {
        throw new ValidationError(
          `O campo "${field}" deve ser um ano entre ${MIN_MODEL_YEAR} e ${maxYear}`,
          { field, year },
        );
      }
    }
    if (modelYear < manufactureYear) {
      throw new ValidationError(
        'O ano-modelo não pode ser anterior ao ano de fabricação',
        { modelYear, manufactureYear },
      );
    }
    if (modelYear - manufactureYear > 1) {
      throw new ValidationError(
        'O ano-modelo pode exceder o ano de fabricação em no máximo 1 ano',
        { modelYear, manufactureYear },
      );
    }
  }

  private static assertMileage(mileageKm: number): void {
    if (!Number.isInteger(mileageKm) || mileageKm < 0 || mileageKm > MAX_MILEAGE_KM) {
      throw new ValidationError(
        `A quilometragem deve ser um inteiro entre 0 e ${MAX_MILEAGE_KM}`,
        { mileageKm },
      );
    }
  }
}
