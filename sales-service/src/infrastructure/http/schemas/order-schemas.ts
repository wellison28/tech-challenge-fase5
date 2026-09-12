import { z } from 'zod';

export const startPurchaseBodySchema = z.object({
  vehicleId: z.string().uuid(),
  /**
   * Opcional: quando ausente, é o `sub` do token. Só a equipe da revenda pode
   * informá-lo explicitamente (venda presencial na loja).
   */
  customerId: z.string().uuid().optional(),
});

export const orderIdParamsSchema = z.object({
  id: z.string().uuid('Identificador de pedido inválido'),
});

export const listOrdersQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  status: z
    .enum([
      'PENDING', 'VEHICLE_RESERVED', 'CUSTOMER_VALIDATED', 'AWAITING_PAYMENT',
      'PAID', 'SALE_CONFIRMED', 'COMPLETED', 'COMPENSATING', 'CANCELLED', 'FAILED',
    ])
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const paymentWebhookBodySchema = z.object({
  /** Id do evento no provedor — usado para deduplicar reentregas. */
  eventId: z.string().min(1).max(200),
  chargeId: z.string().min(1).max(100),
  status: z.enum(['PAID', 'REFUSED', 'EXPIRED']),
});

export const orderResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  status: z.string(),
  amountInCents: z.number().nullable(),
  amountFormatted: z.string().nullable(),
  reservationExpiresAt: z.string().nullable(),
  paymentCode: z.string().nullable(),
  paymentCodeExpiresAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  cancellationDetail: z.string().nullable(),
  timeline: z.array(
    z.object({
      step: z.string(),
      outcome: z.string(),
      at: z.string(),
      detail: z.string().nullable(),
    }),
  ),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const paginatedOrdersSchema = z.object({
  items: z.array(orderResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

export const webhookAckSchema = z.object({
  received: z.boolean(),
  orderStatus: z.string().optional(),
});

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string(),
});
