import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '../../../domain/errors/domain-error';
import { ForbiddenError, UnauthorizedError } from './authenticate';

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  correlationId: string;
}

/**
 * Tradutor único de erros para HTTP.
 *
 * Mantém o domínio ignorante sobre HTTP e garante que nenhuma exceção
 * inesperada vaze stack trace ou mensagem interna para o cliente — detalhe de
 * implementação em corpo de erro é vetor de reconhecimento para um atacante.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = request.id;

    if (error instanceof DomainError) {
      request.log.info({ code: error.code, details: error.details }, error.message);
      return reply.status(error.httpStatus).send({
        code: error.code,
        message: error.message,
        details: error.details,
        correlationId,
      } satisfies ErrorBody);
    }

    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return reply.status(error.httpStatus).send({
        code: error.code,
        message: error.message,
        correlationId,
      } satisfies ErrorBody);
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: 'BAD_REQUEST',
        message: 'Requisição inválida',
        details: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
        correlationId,
      } satisfies ErrorBody);
    }

    const statusCode = (error as FastifyError).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        code: (error as FastifyError).code ?? 'BAD_REQUEST',
        message: error.message,
        correlationId,
      } satisfies ErrorBody);
    }

    request.log.error({ err: error }, 'erro não tratado');
    return reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno. Use o correlationId ao acionar o suporte.',
      correlationId,
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      code: 'ROUTE_NOT_FOUND',
      message: `Rota ${request.method} ${request.url} não existe`,
      correlationId: request.id,
    } satisfies ErrorBody),
  );
}
