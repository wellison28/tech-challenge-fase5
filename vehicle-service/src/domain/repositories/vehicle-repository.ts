import { Vehicle, VehicleStatus } from '../entities/vehicle';

export interface VehicleFilters {
  status?: VehicleStatus;
  brand?: string;
  model?: string;
  color?: string;
  minPriceInCents?: number;
  maxPriceInCents?: number;
  minModelYear?: number;
  maxModelYear?: number;
}

export type VehicleSortField = 'price' | 'modelYear' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

export interface PageQuery {
  page: number;
  pageSize: number;
  sortBy: VehicleSortField;
  sortDirection: SortDirection;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface VehicleRepository {
  create(vehicle: Vehicle): Promise<void>;

  /**
   * Persiste alterações usando trava otimista: a escrita só é aplicada se a
   * versão em banco ainda for `expectedVersion`. Retorna `false` quando outra
   * transação alterou o veículo no meio do caminho — é assim que a disputa por
   * uma mesma unidade em estoque é resolvida sem lock pessimista (que não
   * escala bem em ambiente serverless, com muitas conexões efêmeras).
   */
  update(vehicle: Vehicle, expectedVersion: number): Promise<boolean>;

  findById(id: string): Promise<Vehicle | null>;
  findByVin(vin: string): Promise<Vehicle | null>;
  findByLicensePlate(licensePlate: string): Promise<Vehicle | null>;
  findByOrderId(orderId: string): Promise<Vehicle | null>;
  list(filters: VehicleFilters, page: PageQuery): Promise<Paginated<Vehicle>>;

  /** Reservas vencidas que ainda não voltaram ao estoque. */
  findExpiredReservations(now: Date, limit: number): Promise<Vehicle[]>;
}
