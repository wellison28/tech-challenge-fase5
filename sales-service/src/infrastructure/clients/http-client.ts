import { request } from 'undici';
import { SagaStepError } from '../../domain/errors/domain-error';

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Fornece o token máquina-a-máquina; chamado a cada requisição (com cache interno). */
  getAuthToken: () => Promise<string>;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  correlationId: string;
  /** Nome do passo da SAGA, usado na mensagem de erro e nas métricas. */
  step: string;
}

/**
 * Cliente HTTP dos serviços parceiros.
 *
 * Concentra as decisões de resiliência que, espalhadas pelos adaptadores,
 * acabariam inconsistentes:
 *
 *  - **timeout explícito**: sem ele, uma chamada pendurada consumiria a
 *    execução inteira da Lambda e o cliente esperaria até o limite de 29s do
 *    API Gateway;
 *  - **retry apenas do que é seguro**: 5xx, 429 e erros de rede. Um 409 do
 *    vehicle-service ("já reservado") é definitivo e insistir só queima a
 *    janela de pagamento;
 *  - **backoff exponencial com jitter**: sem o componente aleatório, todas as
 *    execuções que falharam juntas voltariam juntas;
 *  - **propagação do correlation id**, para que uma compra inteira seja
 *    rastreável nos três serviços por um único identificador.
 */
export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async send<T>(input: HttpRequest): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(input);
      } catch (error) {
        lastError = error;

        const retryable = error instanceof SagaStepError ? error.retryable : true;
        if (!retryable || attempt === this.options.maxRetries) {
          break;
        }
        await HttpClient.wait(2 ** (attempt - 1) * 150 + Math.floor(Math.random() * 100));
      }
    }

    throw lastError;
  }

  private async attempt<T>(input: HttpRequest): Promise<T> {
    const token = await this.options.getAuthToken();
    const url = `${this.options.baseUrl}${input.path}`;

    let response;
    try {
      response = await request(url, {
        method: input.method,
        headersTimeout: this.options.timeoutMs,
        bodyTimeout: this.options.timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-correlation-id': input.correlationId,
          ...input.headers,
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch (error) {
      // Falha de rede ou timeout: transitório por natureza.
      throw new SagaStepError(
        input.step,
        `Falha de rede ao chamar ${input.method} ${input.path}: ${String(error)}`,
        true,
        { url },
      );
    }

    const text = await response.body.text();

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return (text ? JSON.parse(text) : undefined) as T;
    }

    // 5xx e 429 são transitórios; 4xx restantes são decisões definitivas do parceiro.
    const retryable = response.statusCode >= 500 || response.statusCode === 429;
    throw new SagaStepError(
      input.step,
      `${input.method} ${input.path} respondeu ${response.statusCode}: ${text.slice(0, 300)}`,
      retryable,
      { statusCode: response.statusCode },
    );
  }

  private static wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
