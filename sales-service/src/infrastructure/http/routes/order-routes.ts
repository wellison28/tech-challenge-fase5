import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ForbiddenError } from '../middlewares/authenticate';
import { Container } from '../../container';
import { TokenVerifier, authenticate, authorize } from '../middlewares/authenticate';
import {
  errorResponseSchema,
  listOrdersQuerySchema,
  orderIdParamsSchema,
  orderResponseSchema,
  paginatedOrdersSchema,
  paymentWebhookBodySchema,
  startPurchaseBodySchema,
  webhookAckSchema,
} from '../schemas/order-schemas';

export const ROLE_ADMIN = 'admin';
export const ROLE_CUSTOMER = 'customer';

export async function orderRoutes(
  app: FastifyInstance,
  container: Container,
  verify: TokenVerifier,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const auth = authenticate(verify);
  const buyerOrStaff = authorize({ roles: [ROLE_CUSTOMER, ROLE_ADMIN] });
  const adminOnly = authorize({ roles: [ROLE_ADMIN] });

  const errors = {
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
    502: errorResponseSchema,
  };

  // ---------------------------------------------------------------------------
  // Processo de compra
  // ---------------------------------------------------------------------------

  typed.post(
    '/orders',
    {
      onRequest: [auth, buyerOrStaff],
      schema: {
        tags: ['Compra'],
        summary: 'Inicia a compra: reserva o veículo e emite o código de pagamento',
        description:
          'Dispara a SAGA. No caminho feliz devolve o pedido em AWAITING_PAYMENT ' +
          'com o código de pagamento. Se o veículo já tiver sido reservado por ' +
          'outro cliente, devolve o pedido em CANCELLED com o motivo.',
        security: [{ bearerAuth: [] }],
        body: startPurchaseBodySchema,
        response: { 201: orderResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const isStaff = principal.roles.includes(ROLE_ADMIN);

      // Um comprador só abre pedido para si mesmo. Sem esta checagem, seria
      // possível iniciar compras em nome de terceiros.
      if (request.body.customerId && request.body.customerId !== principal.subject && !isStaff) {
        throw new ForbiddenError('Você só pode iniciar compras em seu próprio nome');
      }

      const order = await container.useCases.startPurchase.execute({
        customerId: request.body.customerId ?? principal.subject,
        vehicleId: request.body.vehicleId,
        correlationId: request.id,
      });

      return reply.status(201).header('Location', `/orders/${order.id}`).send(order);
    },
  );

  typed.get(
    '/orders/:id',
    {
      onRequest: [auth, buyerOrStaff],
      schema: {
        tags: ['Compra'],
        summary: 'Consulta o pedido e a linha do tempo da SAGA',
        description: 'O código de pagamento só é devolvido ao próprio comprador.',
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema, ...errors },
      },
    },
    async (request) => {
      const principal = request.principal!;
      const order = await container.useCases.getOrder.execute({
        orderId: request.params.id,
        requesterId: principal.subject,
        isStaff: principal.roles.includes(ROLE_ADMIN),
      });

      if (order.customerId !== principal.subject && !principal.roles.includes(ROLE_ADMIN)) {
        throw new ForbiddenError('Você só pode consultar os seus próprios pedidos');
      }
      return order;
    },
  );

  typed.get(
    '/orders',
    {
      onRequest: [auth, buyerOrStaff],
      schema: {
        tags: ['Compra'],
        summary: 'Lista pedidos',
        description: 'Um comprador vê apenas os próprios pedidos; `admin` vê todos.',
        security: [{ bearerAuth: [] }],
        querystring: listOrdersQuerySchema,
        response: { 200: paginatedOrdersSchema, ...errors },
      },
    },
    async (request) => {
      const principal = request.principal!;
      const isStaff = principal.roles.includes(ROLE_ADMIN);
      const { page, pageSize, ...filters } = request.query;

      return container.useCases.listOrders.execute(
        // O filtro é forçado para o próprio comprador: ignorar o customerId da
        // query impede que alguém liste os pedidos de outra pessoa.
        { ...filters, customerId: isStaff ? filters.customerId : principal.subject },
        { page, pageSize },
      );
    },
  );

  typed.post(
    '/orders/:id/cancellation',
    {
      onRequest: [auth, buyerOrStaff],
      schema: {
        tags: ['Compra'],
        summary: 'Desistência do cliente — dispara a compensação da SAGA',
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema, ...errors },
      },
    },
    async (request) => {
      const principal = request.principal!;
      const order = await container.useCases.getOrder.execute({
        orderId: request.params.id,
        requesterId: principal.subject,
        isStaff: principal.roles.includes(ROLE_ADMIN),
      });
      if (order.customerId !== principal.subject && !principal.roles.includes(ROLE_ADMIN)) {
        throw new ForbiddenError('Você só pode cancelar os seus próprios pedidos');
      }

      return container.useCases.cancelPurchase.execute({
        orderId: request.params.id,
        requestedBy: principal.subject,
        correlationId: request.id,
      });
    },
  );

  typed.post(
    '/orders/:id/pickup',
    {
      onRequest: [auth, adminOnly],
      schema: {
        tags: ['Compra'],
        summary: 'Registra a retirada do veículo (conclui o processo)',
        description: 'Executado pela loja no balcão, após conferir a documentação.',
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema, ...errors },
      },
    },
    async (request) =>
      container.useCases.deliverVehicle.execute({
        orderId: request.params.id,
        correlationId: request.id,
      }),
  );

  // ---------------------------------------------------------------------------
  // Webhook do provedor de pagamento
  // ---------------------------------------------------------------------------

  typed.post(
    '/webhooks/payments',
    {
      /**
       * Não exige token: quem chama é o provedor de pagamento, que não tem
       * credencial no Cognito. A autenticidade é garantida pela assinatura
       * HMAC do corpo — sem ela, qualquer um poderia declarar um pedido como
       * pago e retirar um veículo sem pagar.
       */
      schema: {
        tags: ['Pagamento'],
        summary: 'Recebe a confirmação de pagamento do provedor',
        description:
          'Exige a assinatura HMAC-SHA256 no cabeçalho X-Signature. ' +
          'É idempotente: reentregas do mesmo evento não têm efeito.',
        body: paymentWebhookBodySchema,
        response: { 200: webhookAckSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const signature = request.headers['x-signature'] as string | undefined;
      // Bytes exatamente como o provedor os assinou (ver o parser em app.ts).
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';

      if (
        !signature ||
        !container.payments.verifyWebhookSignature({ rawBody, signature })
      ) {
        request.log.warn(
          { chargeId: request.body.chargeId },
          'webhook de pagamento com assinatura inválida',
        );
        return reply.status(401).send({
          code: 'INVALID_SIGNATURE',
          message: 'Assinatura do webhook inválida',
          correlationId: request.id,
        });
      }

      const order = await container.useCases.confirmPayment.execute({
        chargeId: request.body.chargeId,
        outcome: request.body.status,
        correlationId: request.id,
      });

      return { received: true, orderStatus: order.status };
    },
  );
}
