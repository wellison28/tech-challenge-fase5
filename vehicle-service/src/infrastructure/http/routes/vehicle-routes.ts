import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Container } from '../../container';
import { TokenVerifier, authenticate, authorize } from '../middlewares/authenticate';
import {
  catalogQuerySchema,
  confirmSaleBodySchema,
  createVehicleBodySchema,
  errorResponseSchema,
  listVehiclesQuerySchema,
  paginatedVehiclesSchema,
  releaseReservationBodySchema,
  releaseReservationResponseSchema,
  reservationResponseSchema,
  reserveVehicleBodySchema,
  updateVehicleBodySchema,
  vehicleIdParamsSchema,
  vehicleResponseSchema,
} from '../schemas/vehicle-schemas';

/** Papéis (grupos do Cognito) e escopos máquina-a-máquina usados nas rotas. */
export const ROLE_ADMIN = 'admin';
export const SCOPE_RESERVE = 'revenda/vehicles.reserve';
export const SCOPE_SELL = 'revenda/vehicles.sell';

export async function vehicleRoutes(
  app: FastifyInstance,
  container: Container,
  verify: TokenVerifier,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const auth = authenticate(verify);
  const adminOnly = authorize({ roles: [ROLE_ADMIN] });
  const sagaReserve = authorize({ roles: [ROLE_ADMIN], scopes: [SCOPE_RESERVE] });
  const sagaSell = authorize({ roles: [ROLE_ADMIN], scopes: [SCOPE_SELL] });

  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
  };

  // ---------------------------------------------------------------------------
  // Catálogo — leitura pública (a vitrine da revenda não exige login)
  // ---------------------------------------------------------------------------

  typed.get(
    '/vehicles',
    {
      schema: {
        tags: ['Catálogo'],
        summary: 'Lista veículos com filtros e ordenação',
        querystring: listVehiclesQuerySchema,
        response: { 200: paginatedVehiclesSchema, ...errors },
      },
    },
    async (request) => container.useCases.listVehicles.execute(request.query),
  );

  typed.get(
    '/vehicles/available',
    {
      schema: {
        tags: ['Catálogo'],
        summary: 'Veículos à venda, do mais barato para o mais caro',
        querystring: catalogQuerySchema,
        response: { 200: paginatedVehiclesSchema, ...errors },
      },
    },
    async (request) => container.useCases.listVehicles.listAvailable(request.query),
  );

  typed.get(
    '/vehicles/sold',
    {
      schema: {
        tags: ['Catálogo'],
        summary: 'Veículos vendidos, do mais barato para o mais caro',
        querystring: catalogQuerySchema,
        response: { 200: paginatedVehiclesSchema, ...errors },
      },
    },
    async (request) => container.useCases.listVehicles.listSold(request.query),
  );

  typed.get(
    '/vehicles/:id',
    {
      schema: {
        tags: ['Catálogo'],
        summary: 'Detalha um veículo',
        params: vehicleIdParamsSchema,
        response: { 200: vehicleResponseSchema, ...errors },
      },
    },
    async (request) => container.useCases.getVehicle.execute(request.params.id),
  );

  // ---------------------------------------------------------------------------
  // Gestão de estoque — exclusivo da equipe da revenda
  // ---------------------------------------------------------------------------

  typed.post(
    '/vehicles',
    {
      onRequest: [auth, adminOnly],
      schema: {
        tags: ['Estoque'],
        summary: 'Cadastra um veículo para venda',
        security: [{ bearerAuth: [] }],
        body: createVehicleBodySchema,
        response: { 201: vehicleResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const vehicle = await container.useCases.registerVehicle.execute({
        ...request.body,
        correlationId: request.id,
      });
      return reply.status(201).header('Location', `/vehicles/${vehicle.id}`).send(vehicle);
    },
  );

  typed.put(
    '/vehicles/:id',
    {
      onRequest: [auth, adminOnly],
      schema: {
        tags: ['Estoque'],
        summary: 'Edita os dados de um veículo',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamsSchema,
        body: updateVehicleBodySchema,
        response: { 200: vehicleResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.updateVehicle.execute({
        ...request.body,
        vehicleId: request.params.id,
        correlationId: request.id,
      }),
  );

  // ---------------------------------------------------------------------------
  // Passos da SAGA — chamados pelo sales-service via Step Functions.
  // Token máquina-a-máquina (client_credentials do Cognito); nenhum comprador
  // alcança estas rotas.
  // ---------------------------------------------------------------------------

  typed.post(
    '/vehicles/:id/reservations',
    {
      onRequest: [auth, sagaReserve],
      schema: {
        tags: ['SAGA'],
        summary: 'Reserva o veículo para um pedido (passo 1, idempotente)',
        description:
          'Bloqueia a unidade por RESERVATION_TTL_MINUTES. Devolve 409 quando outro pedido ' +
          'reservou o veículo primeiro — é o passo que resolve a disputa de estoque.',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamsSchema,
        body: reserveVehicleBodySchema,
        response: { 200: reservationResponseSchema, 201: reservationResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await container.useCases.reserveVehicle.execute({
        vehicleId: request.params.id,
        customerId: request.body.customerId,
        orderId: request.body.orderId,
        correlationId: request.id,
      });
      return reply.status(result.alreadyReserved ? 200 : 201).send(result);
    },
  );

  typed.post(
    '/vehicles/:id/reservations/release',
    {
      onRequest: [auth, sagaReserve],
      schema: {
        tags: ['SAGA'],
        summary: 'Libera a reserva (compensação, idempotente)',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamsSchema,
        body: releaseReservationBodySchema,
        response: { 200: releaseReservationResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.releaseReservation.execute({
        vehicleId: request.params.id,
        orderId: request.body.orderId,
        reservationId: request.body.reservationId,
        reason: request.body.reason,
        correlationId: request.id,
      }),
  );

  typed.post(
    '/vehicles/:id/sale',
    {
      onRequest: [auth, sagaSell],
      schema: {
        tags: ['SAGA'],
        summary: 'Confirma a venda e dá baixa no estoque (passo final, idempotente)',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamsSchema,
        body: confirmSaleBodySchema,
        response: { 200: vehicleResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.confirmVehicleSale.execute({
        vehicleId: request.params.id,
        orderId: request.body.orderId,
        customerId: request.body.customerId,
        correlationId: request.id,
      }),
  );
}
