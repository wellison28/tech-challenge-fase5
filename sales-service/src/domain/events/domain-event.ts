/**
 * Eventos do processo de venda.
 *
 * Assim como no customer-service, nenhum payload carrega dado pessoal: apenas
 * identificadores opacos e valores. O `paymentCode` também não é publicado —
 * ele é entregue ao cliente pela resposta da API, não pelo barramento.
 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  readonly eventId: string;
  readonly eventType: OrderEventType;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly aggregateId: string;
  readonly aggregateType: 'order';
  readonly correlationId: string;
  readonly payload: TPayload;
}

export const OrderEventType = {
  STARTED: 'order.started',
  VEHICLE_RESERVED: 'order.vehicle_reserved',
  PAYMENT_CODE_ISSUED: 'order.payment_code_issued',
  PAID: 'order.paid',
  SALE_CONFIRMED: 'order.sale_confirmed',
  COMPLETED: 'order.completed',
  CANCELLED: 'order.cancelled',
  FAILED: 'order.failed',
} as const;
export type OrderEventType = (typeof OrderEventType)[keyof typeof OrderEventType];

export interface OrderPayload {
  orderId: string;
  customerId: string;
  vehicleId: string;
  status: string;
  amountInCents?: number;
  reason?: string;
  [key: string]: unknown;
}
