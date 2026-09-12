import { Order } from '../../domain/entities/order';

export interface OrderDTO {
  id: string;
  customerId: string;
  vehicleId: string;
  status: string;
  amountInCents: number | null;
  amountFormatted: string | null;
  reservationExpiresAt: string | null;
  /** Só é devolvido ao próprio comprador; ver a rota de consulta do pedido. */
  paymentCode: string | null;
  paymentCodeExpiresAt: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  cancellationReason: string | null;
  cancellationDetail: string | null;
  timeline: Array<{ step: string; outcome: string; at: string; detail: string | null }>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toOrderDTO(order: Order, options: { includePaymentCode: boolean }): OrderDTO {
  return {
    id: order.id,
    customerId: order.customerId,
    vehicleId: order.vehicleId,
    status: order.status,
    amountInCents: order.amount?.cents ?? null,
    amountFormatted: order.amount?.format() ?? null,
    reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null,
    paymentCode: options.includePaymentCode ? order.paymentCode : null,
    paymentCodeExpiresAt: order.paymentCodeExpiresAt?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    cancellationReason: order.cancellationReason,
    cancellationDetail: order.cancellationDetail,
    timeline: order.timeline.map((entry) => ({
      step: entry.step,
      outcome: entry.outcome,
      at: entry.at.toISOString(),
      detail: entry.detail,
    })),
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
