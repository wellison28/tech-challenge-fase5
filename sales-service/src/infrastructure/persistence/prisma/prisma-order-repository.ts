import type { Prisma, PrismaClient } from '@prisma/client';
import { Order, OrderStatus, TERMINAL_STATUSES } from '../../../domain/entities/order';
import {
  OrderFilters,
  OrderRepository,
  PageQuery,
  Paginated,
} from '../../../domain/repositories/order-repository';
import { OrderMapper } from './order-mapper';

type Client = PrismaClient | Prisma.TransactionClient;

export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly client: Client) {}

  async create(order: Order): Promise<void> {
    await this.client.order.create({ data: OrderMapper.toPersistence(order) });
  }

  async update(order: Order, expectedVersion: number): Promise<boolean> {
    const { id, createdAt: _createdAt, ...data } = OrderMapper.toPersistence(order);
    const result = await this.client.order.updateMany({
      where: { id, version: expectedVersion },
      data,
    });
    return result.count === 1;
  }

  async findById(id: string): Promise<Order | null> {
    const row = await this.client.order.findUnique({ where: { id } });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async findByPaymentChargeId(chargeId: string): Promise<Order | null> {
    const row = await this.client.order.findUnique({ where: { paymentChargeId: chargeId } });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async findActiveByCustomerAndVehicle(
    customerId: string,
    vehicleId: string,
  ): Promise<Order | null> {
    const row = await this.client.order.findFirst({
      where: {
        customerId,
        vehicleId,
        status: { notIn: TERMINAL_STATUSES as OrderStatus[] },
      },
      orderBy: { createdAt: 'desc' },
    });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async list(filters: OrderFilters, page: PageQuery): Promise<Paginated<Order>> {
    const where: Prisma.OrderWhereInput = {
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.client.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.client.order.count({ where }),
    ]);

    return {
      items: rows.map(OrderMapper.toDomain),
      total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: Math.max(1, Math.ceil(total / page.pageSize)),
    };
  }

  async findExpiredAwaitingPayment(now: Date, limit: number): Promise<Order[]> {
    const rows = await this.client.order.findMany({
      where: {
        status: OrderStatus.AWAITING_PAYMENT,
        paymentCodeExpiresAt: { lte: now },
      },
      orderBy: { paymentCodeExpiresAt: 'asc' },
      take: limit,
    });
    return rows.map(OrderMapper.toDomain);
  }
}
