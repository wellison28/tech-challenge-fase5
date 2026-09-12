import { CancellationReason, OrderStatus } from '../../domain/entities/order';
import { SagaStepError } from '../../domain/errors/domain-error';
import { PurchaseSagaSteps, StepOutput } from './steps';

export interface SagaLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Orquestrador em processo da SAGA de compra.
 *
 * Em produção o orquestrador é o **AWS Step Functions** (ver
 * `infra/statemachine/purchase-saga.asl.json`): ele dá retry com backoff,
 * timeout, histórico visual de cada execução e espera por callback sem manter
 * processo vivo. Esta classe existe para dois fins legítimos:
 *
 *  1. rodar a plataforma inteira localmente, sem depender da nuvem;
 *  2. **testar a orquestração** — a ordem dos passos, a decisão de compensar e
 *     o resultado de cada falha — de forma determinística e rápida.
 *
 * Os dois modos chamam exatamente os mesmos passos (`PurchaseSagaSteps`). O
 * que muda é quem decide a ordem. Essa simetria é o que impede que a lógica de
 * negócio fique presa dentro de um JSON de máquina de estados.
 *
 * O fluxo síncrono vai até a emissão do código de pagamento. A confirmação do
 * pagamento é assíncrona (webhook do provedor) e retoma o processo a partir do
 * passo 5 — por isso `run` termina em `AWAITING_PAYMENT`, e não em
 * `COMPLETED`.
 */
export class PurchaseSagaOrchestrator {
  constructor(
    private readonly steps: PurchaseSagaSteps,
    private readonly logger: SagaLogger,
    private readonly maxAttemptsPerStep = 3,
  ) {}

  async run(params: { orderId: string; correlationId: string }): Promise<StepOutput> {
    const input = { orderId: params.orderId, correlationId: params.correlationId };

    const pipeline: Array<{ name: string; execute: () => Promise<StepOutput> }> = [
      { name: 'RESERVE_VEHICLE', execute: () => this.steps.reserveVehicle(input) },
      { name: 'VALIDATE_CUSTOMER', execute: () => this.steps.validateCustomer(input) },
      { name: 'CREATE_PAYMENT', execute: () => this.steps.createPayment(input) },
    ];

    let last: StepOutput = { orderId: params.orderId, status: OrderStatus.PENDING };

    for (const step of pipeline) {
      try {
        last = await this.withRetry(step.name, step.execute, params.correlationId);
        this.logger.info({ orderId: params.orderId, step: step.name }, 'passo concluído');
      } catch (error) {
        const reason = PurchaseSagaOrchestrator.cancellationReasonFor(error);
        this.logger.warn(
          { orderId: params.orderId, step: step.name, reason, err: String(error) },
          'passo falhou; iniciando compensação',
        );

        return this.steps.compensate({
          ...input,
          reason,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return last;
  }

  /**
   * Retenta apenas o que é transitório.
   *
   * Um 409 "veículo já reservado" não melhora com nova tentativa — insistir só
   * consome a janela de pagamento. O backoff é exponencial com *jitter*: sem o
   * componente aleatório, várias SAGAs que falharam juntas voltariam juntas e
   * repetiriam a sobrecarga que causou a falha.
   */
  private async withRetry(
    stepName: string,
    execute: () => Promise<StepOutput>,
    correlationId: string,
  ): Promise<StepOutput> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttemptsPerStep; attempt += 1) {
      try {
        return await execute();
      } catch (error) {
        lastError = error;

        const retryable = !(error instanceof SagaStepError) || error.retryable;
        if (!retryable || attempt === this.maxAttemptsPerStep) {
          break;
        }

        const backoffMs = 2 ** (attempt - 1) * 200;
        const jitterMs = Math.floor(Math.random() * 100);
        this.logger.warn(
          { step: stepName, attempt, correlationId, waitMs: backoffMs + jitterMs },
          'falha transitória; nova tentativa agendada',
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs + jitterMs));
      }
    }

    throw lastError;
  }

  /** Traduz a falha do passo no motivo de cancelamento registrado no pedido. */
  private static cancellationReasonFor(error: unknown): CancellationReason {
    if (error instanceof SagaStepError) {
      const declared = error.details?.['cancellationReason'];
      if (typeof declared === 'string') {
        return declared as CancellationReason;
      }
    }
    return CancellationReason.SYSTEM_FAILURE;
  }
}
