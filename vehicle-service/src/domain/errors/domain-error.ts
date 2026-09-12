/**
 * Erros de domínio. São traduzidos para status HTTP na borda (infrastructure/http),
 * mantendo o núcleo do domínio livre de qualquer dependência de transporte.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  protected constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Violação de invariante de entrada (valor inválido, formato incorreto). */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** Recurso inexistente. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(resource: string, identifier: string) {
    super(`${resource} não encontrado(a): ${identifier}`, { resource, identifier });
  }
}

/**
 * Transição de estado ilegal ou conflito de concorrência.
 * É o erro devolvido quando dois clientes disputam a mesma unidade em estoque.
 */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** Violação de unicidade de negócio (chassi/placa já cadastrados). */
export class DuplicateResourceError extends DomainError {
  readonly code = 'DUPLICATE_RESOURCE';
  readonly httpStatus = 409;

  constructor(field: string, value: string) {
    super(`Já existe um veículo cadastrado com ${field} = ${value}`, { field, value });
  }
}
