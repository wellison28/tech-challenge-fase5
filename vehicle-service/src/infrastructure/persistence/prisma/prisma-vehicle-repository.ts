import type { Prisma, PrismaClient } from '@prisma/client';
import { Vehicle, VehicleStatus } from '../../../domain/entities/vehicle';
import {
  PageQuery,
  Paginated,
  VehicleFilters,
  VehicleRepository,
  VehicleSortField,
} from '../../../domain/repositories/vehicle-repository';
import { VehicleMapper } from './vehicle-mapper';

type Client = PrismaClient | Prisma.TransactionClient;

const SORT_COLUMN: Record<VehicleSortField, string> = {
  price: 'priceInCents',
  modelYear: 'modelYear',
  createdAt: 'createdAt',
};

export class PrismaVehicleRepository implements VehicleRepository {
  constructor(private readonly client: Client) {}

  async create(vehicle: Vehicle): Promise<void> {
    await this.client.vehicle.create({ data: VehicleMapper.toPersistence(vehicle) });
  }

  /**
   * Trava otimista. O `where` inclui a versão lida pelo caso de uso; se outra
   * transação tiver escrito antes, `count` volta 0 e o chamador trata como
   * conflito (409) em vez de sobrescrever silenciosamente.
   */
  async update(vehicle: Vehicle, expectedVersion: number): Promise<boolean> {
    // `createdAt` é imutável: descartado para que um UPDATE nunca reescreva a
    // data de entrada do veículo no estoque.
    const { id, createdAt: _createdAt, ...data } = VehicleMapper.toPersistence(vehicle);
    const result = await this.client.vehicle.updateMany({
      where: { id, version: expectedVersion },
      data,
    });
    return result.count === 1;
  }

  async findById(id: string): Promise<Vehicle | null> {
    const row = await this.client.vehicle.findUnique({ where: { id } });
    return row ? VehicleMapper.toDomain(row) : null;
  }

  async findByVin(vin: string): Promise<Vehicle | null> {
    const row = await this.client.vehicle.findUnique({ where: { vin } });
    return row ? VehicleMapper.toDomain(row) : null;
  }

  async findByLicensePlate(licensePlate: string): Promise<Vehicle | null> {
    const row = await this.client.vehicle.findUnique({ where: { licensePlate } });
    return row ? VehicleMapper.toDomain(row) : null;
  }

  async findByOrderId(orderId: string): Promise<Vehicle | null> {
    const row = await this.client.vehicle.findFirst({
      where: { OR: [{ reservationOrderId: orderId }, { saleOrderId: orderId }] },
    });
    return row ? VehicleMapper.toDomain(row) : null;
  }

  async list(filters: VehicleFilters, page: PageQuery): Promise<Paginated<Vehicle>> {
    const where = this.buildWhere(filters);
    const orderBy = [
      { [SORT_COLUMN[page.sortBy]]: page.sortDirection },
      // Desempate estável: sem ele, veículos de mesmo preço podem trocar de
      // página entre requisições e sumir da paginação do frontend.
      { id: 'asc' as const },
    ];

    const [rows, total] = await Promise.all([
      this.client.vehicle.findMany({
        where,
        orderBy,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.client.vehicle.count({ where }),
    ]);

    return {
      items: rows.map(VehicleMapper.toDomain),
      total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: Math.max(1, Math.ceil(total / page.pageSize)),
    };
  }

  async findExpiredReservations(now: Date, limit: number): Promise<Vehicle[]> {
    const rows = await this.client.vehicle.findMany({
      where: {
        status: VehicleStatus.RESERVED,
        reservationExpiresAt: { lte: now },
      },
      orderBy: { reservationExpiresAt: 'asc' },
      take: limit,
    });
    return rows.map(VehicleMapper.toDomain);
  }

  private buildWhere(filters: VehicleFilters): Prisma.VehicleWhereInput {
    const where: Prisma.VehicleWhereInput = {};

    if (filters.status) where.status = filters.status;
    if (filters.brand) where.brand = { contains: filters.brand, mode: 'insensitive' };
    if (filters.model) where.model = { contains: filters.model, mode: 'insensitive' };
    if (filters.color) where.color = { equals: filters.color, mode: 'insensitive' };

    if (filters.minPriceInCents !== undefined || filters.maxPriceInCents !== undefined) {
      where.priceInCents = {
        ...(filters.minPriceInCents !== undefined ? { gte: filters.minPriceInCents } : {}),
        ...(filters.maxPriceInCents !== undefined ? { lte: filters.maxPriceInCents } : {}),
      };
    }
    if (filters.minModelYear !== undefined || filters.maxModelYear !== undefined) {
      where.modelYear = {
        ...(filters.minModelYear !== undefined ? { gte: filters.minModelYear } : {}),
        ...(filters.maxModelYear !== undefined ? { lte: filters.maxModelYear } : {}),
      };
    }

    return where;
  }
}
