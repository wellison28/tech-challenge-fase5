import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { buildContainer } from './infrastructure/container';
import { buildApp } from './infrastructure/http/app';

/**
 * Adaptador HTTP → AWS Lambda.
 *
 * O mesmo app Fastify roda como processo (docker-compose, para desenvolver e
 * testar) e como função gerenciada atrás do API Gateway (em produção). Nenhuma
 * regra de negócio sabe em qual dos dois está: só muda o adaptador de entrada.
 *
 * A inicialização acontece no escopo do módulo, aproveitando o container
 * reutilizado entre invocações — o custo de bootstrap é pago no cold start, não
 * em toda requisição.
 */
const bootstrap = (async () => {
  const container = buildContainer();
  const app = await buildApp(container);
  await app.ready();
  return awsLambdaFastify(app, { serializeLambdaArguments: true });
})();

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  // Não espera o event loop esvaziar: mantém conexões de banco vivas entre invocações.
  context.callbackWaitsForEmptyEventLoop = false;
  const proxy = await bootstrap;
  return proxy(event, context) as Promise<APIGatewayProxyResult>;
}
