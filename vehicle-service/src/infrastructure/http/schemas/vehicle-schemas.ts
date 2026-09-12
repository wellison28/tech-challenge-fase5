import { z } from 'zod';
import { FuelType, Transmission } from '../../../domain/entities/vehicle';

export const fuelTypeSchema = z.nativeEnum(FuelType);
export const transmissionSchema = z.nativeEnum(Transmission);

const priceInCentsSchema = z
  .number()
  .int('O preço deve ser informado em centavos, como número inteiro')
  .positive()
  .max(2_000_000_000);

export const createVehicleBodySchema = z.object({
  vin: z.string().length(17, 'O chassi (VIN) tem 17 caracteres'),
  licensePlate: z.string().min(7).max(8).optional().nullable(),
  brand: z.string().min(1).max(60),
  model: z.string().min(1).max(80),
  modelYear: z.number().int().min(1900),
  manufactureYear: z.number().int().min(1900),
  color: z.string().min(1).max(40),
  mileageKm: z.number().int().min(0).max(2_000_000),
  fuelType: fuelTypeSchema,
  transmission: transmissionSchema,
  priceInCents: priceInCentsSchema,
});

export const updateVehicleBodySchema = createVehicleBodySchema
  .omit({ vin: true })
  .partial()
  .extend({
    /** Concorrência otimista opcional: rejeita a escrita se o registro mudou. */
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  });

export const vehicleIdParamsSchema = z.object({
  id: z.string().uuid('Identificador de veículo inválido'),
});

export const listVehiclesQuerySchema = z.object({
  status: z.enum(['AVAILABLE', 'RESERVED', 'SOLD']).optional(),
  brand: z.string().max(60).optional(),
  model: z.string().max(80).optional(),
  color: z.string().max(40).optional(),
  minPriceInCents: z.coerce.number().int().min(0).optional(),
  maxPriceInCents: z.coerce.number().int().min(0).optional(),
  minModelYear: z.coerce.number().int().min(1900).optional(),
  maxModelYear: z.coerce.number().int().min(1900).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sortBy: z.enum(['price', 'modelYear', 'createdAt']).default('price'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
});

/** Listagens do requisito: ordenação fixa por preço crescente, não negociável via query. */
export const catalogQuerySchema = listVehiclesQuerySchema.omit({
  status: true,
  sortBy: true,
  sortDirection: true,
});

export const reserveVehicleBodySchema = z.object({
  customerId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export const releaseReservationBodySchema = z.object({
  orderId: z.string().uuid(),
  reservationId: z.string().uuid().optional(),
  reason: z
    .enum(['SAGA_COMPENSATION', 'CUSTOMER_GAVE_UP', 'RESERVATION_EXPIRED', 'PAYMENT_FAILED'])
    .default('SAGA_COMPENSATION'),
});

export const confirmSaleBodySchema = z.object({
  orderId: z.string().uuid(),
  customerId: z.string().uuid(),
});

export const vehicleResponseSchema = z.object({
  id: z.string().uuid(),
  vin: z.string(),
  licensePlate: z.string().nullable(),
  brand: z.string(),
  model: z.string(),
  modelYear: z.number(),
  manufactureYear: z.number(),
  color: z.string(),
  mileageKm: z.number(),
  fuelType: z.string(),
  transmission: z.string(),
  priceInCents: z.number(),
  price: z.number(),
  priceFormatted: z.string(),
  status: z.string(),
  reservation: z
    .object({ id: z.string(), orderId: z.string(), expiresAt: z.string() })
    .nullable(),
  sale: z
    .object({ orderId: z.string(), soldAt: z.string(), soldPriceInCents: z.number() })
    .nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const paginatedVehiclesSchema = z.object({
  items: z.array(vehicleResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string(),
});

export const reservationResponseSchema = z.object({
  reservationId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  orderId: z.string().uuid(),
  priceInCents: z.number().int(),
  expiresAt: z.string(),
  /** `true` indica reexecução do passo da SAGA sobre uma reserva já existente. */
  alreadyReserved: z.boolean(),
});

export const releaseReservationResponseSchema = z.object({
  released: z.boolean(),
});
