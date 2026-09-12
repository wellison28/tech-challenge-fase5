import type { Order as OrderRow, Prisma } from '@prisma/client';
import {
  CancellationReason,
  Order,
  OrderStatus,
  SagaStep,
  TimelineEntry,
} from '../../../domain/entities/order';
import { Money } from '../../../domain/value-objects/money';

interface StoredTimelineEntry {
  step: string;
  outcome: string;
  at: string;
  detail: string | null;
}

export const OrderMapper = {
  toDomain(row: OrderRow): Order {
    const stored = (row.timeline as unknown as StoredTimelineEntry[]) ?? [];

    return Order.restore({
      id: row.id,
      customerId: row.customerId,
      vehicleId: row.vehicleId,
      amount: row.amountInCents !== null ? Money.fromCents(row.amountInCents) : null,
      status: row.status as OrderStatus,
      reservationId: row.reservationId,
      reservationExpiresAt: row.reservationExpiresAt,
      paymentChargeId: row.paymentChargeId,
      sagaTaskToken: row.sagaTaskToken,
      paymentCode: row.paymentCode,
      paymentCodeExpiresAt: row.paymentCodeExpiresAt,
      paidAt: row.paidAt,
      deliveredAt: row.deliveredAt,
      cancellationReason: row.cancellationReason as CancellationReason | null,
      cancellationDetail: row.cancellationDetail,
      timeline: stored.map((entry) => ({
        step: entry.step as SagaStep,
        outcome: entry.outcome as TimelineEntry['outcome'],
        at: new Date(entry.at),
        detail: entry.detail,
      })),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toPersistence(order: Order) {
    const snapshot = order.toSnapshot();
    return {
      id: snapshot.id,
      customerId: snapshot.customerId,
      vehicleId: snapshot.vehicleId,
      status: snapshot.status,
      version: snapshot.version,
      amountInCents: snapshot.amount?.cents ?? null,
      reservationId: snapshot.reservationId,
      reservationExpiresAt: snapshot.reservationExpiresAt,
      paymentChargeId: snapshot.paymentChargeId,
      sagaTaskToken: snapshot.sagaTaskToken,
      paymentCode: snapshot.paymentCode,
      paymentCodeExpiresAt: snapshot.paymentCodeExpiresAt,
      paidAt: snapshot.paidAt,
      deliveredAt: snapshot.deliveredAt,
      cancellationReason: snapshot.cancellationReason,
      cancellationDetail: snapshot.cancellationDetail,
      timeline: snapshot.timeline.map((entry) => ({
        step: entry.step,
        outcome: entry.outcome,
        at: entry.at.toISOString(),
        detail: entry.detail,
      })) as unknown as Prisma.InputJsonValue,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  },
};
