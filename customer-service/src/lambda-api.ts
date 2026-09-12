import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { buildContainer } from './infrastructure/container';
import { buildApp } from './infrastructure/http/app';

/**
 * Adaptador HTTP → AWS Lambda.
 *
 * O bootstrap busca o pepper no Secrets Manager e inicializa o cliente KMS;
 * fica no escopo do módulo para que esse custo seja pago uma vez por cold
 * start e não a cada requisição.
 */
const bootstrap = (async () => {
  const container = await buildContainer();
  const app = await buildApp(container);
  await app.ready();
  return awsLambdaFastify(app, { serializeLambdaArguments: true });
})();

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  context.callbackWaitsForEmptyEventLoop = false;
  const proxy = await bootstrap;
  return proxy(event, context) as Promise<APIGatewayProxyResult>;
}
