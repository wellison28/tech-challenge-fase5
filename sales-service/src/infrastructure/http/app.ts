import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { Container } from '../container';
import { createTokenVerifier } from './middlewares/authenticate';
import { registerErrorHandler } from './middlewares/error-handler';
import { healthRoutes } from './routes/health-routes';
import { orderRoutes } from './routes/order-routes';

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const { env, logger } = container;

  const app = Fastify({
    // O cast mantém a instância tipada como FastifyInstance padrão: sem ele o
    // tipo do logger do pino vaza para a assinatura de todas as rotas.
    // Fastify 5: instância de logger pronta vai em `loggerInstance`.
    loggerInstance: logger as FastifyBaseLogger,
    /**
     * O correlation id vem do cliente quando existir (`x-correlation-id`), e é
     * gerado quando não. Propagá-lo por toda a SAGA é o que permite reconstruir
     * uma compra inteira — três serviços e um Step Functions — a partir de um
     * único identificador no CloudWatch Logs Insights.
     */
    genReqId: (request) =>
      (request.headers['x-correlation-id'] as string | undefined) ?? randomUUID(),
    trustProxy: true,
    /** Barra payloads absurdos antes de chegarem ao parser. */
    bodyLimit: 256 * 1024,
    disableRequestLogging: false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /**
   * Preserva o corpo bruto da requisição.
   *
   * A assinatura HMAC do webhook de pagamento é calculada sobre os **bytes
   * enviados**. Reserializar o objeto já parseado (`JSON.stringify`) produz
   * outra sequência de bytes — ordem de chaves, espaçamento e escapes podem
   * diferir — e a verificação falharia para requisições legítimas, ou pior,
   * passaria a validar algo que não foi o que o provedor assinou.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body: string, done) => {
      (request as unknown as { rawBody?: string }).rawBody = body;
      try {
        done(null, body.length > 0 ? JSON.parse(body) : undefined);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // ---- Segurança de borda ----
  await app.register(helmet, {
    // A API não serve HTML; CSP restritiva evita que a UI do Swagger vire
    // superfície de XSS caso seja habilitada em ambiente não produtivo.
    contentSecurityPolicy: env.NODE_ENV === 'production',
  });

  await app.register(cors, {
    origin: env.CORS_ALLOWED_ORIGINS === '*' ? true : env.CORS_ALLOWED_ORIGINS.split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-Signature'],
    maxAge: 600,
  });

  /**
   * Rate limit na aplicação além do WAF/API Gateway: defesa em profundidade.
   * Se a API for exposta por outro caminho (teste de carga interno, chamada
   * dentro da VPC), o limite continua valendo.
   */
  await app.register(rateLimit, {
    max: env.NODE_ENV === 'production' ? 300 : 10_000,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.principal?.subject ?? request.ip,
  });

  registerErrorHandler(app);

  // ---- Documentação ----
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Revenda de Veículos — Sales Service',
        description:
          'Processo de compra ponta a ponta. Orquestra a SAGA (reserva do ' +
          'veículo, validação do comprador, emissão do código de pagamento, ' +
          'baixa no estoque e retirada) e executa as compensações quando o ' +
          'pagamento falha, expira ou o cliente desiste.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${env.PORT}`, description: 'Local' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      tags: [
        { name: 'Compra', description: 'Processo de compra do cliente' },
        { name: 'Pagamento', description: 'Integração com o provedor de pagamento' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  if (env.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  // ---- Rotas ----
  const verify = createTokenVerifier(env);
  await app.register(async (instance) => healthRoutes(instance, container));
  await app.register(async (instance) => orderRoutes(instance, container, verify));

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Correlation-Id', request.id);
  });

  return app;
}
