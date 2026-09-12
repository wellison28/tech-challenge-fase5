import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { SagaLauncherPort } from '../../application/ports/saga-launcher';
import { PurchaseSagaOrchestrator } from '../../application/saga/orchestrator';

/**
 * Dispara a máquina de estados do Step Functions.
 *
 * O nome da execução é derivado do `orderId`: o Step Functions recusa nomes
 * repetidos dentro da janela de deduplicação, o que impede que um clique duplo
 * abra duas execuções para a mesma compra.
 */
export class StepFunctionsSagaLauncher implements SagaLauncherPort {
  private readonly client: SFNClient;

  constructor(
    private readonly stateMachineArn: string,
    options: { region: string; endpoint?: string },
  ) {
    this.client = new SFNClient({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
  }

  async start(params: {
    orderId: string;
    correlationId: string;
  }): Promise<{ executionRef: string }> {
    const response = await this.client.send(
      new StartExecutionCommand({
        stateMachineArn: this.stateMachineArn,
        name: `order-${params.orderId}`,
        input: JSON.stringify({
          orderId: params.orderId,
          correlationId: params.correlationId,
        }),
      }),
    );

    return { executionRef: response.executionArn ?? `order-${params.orderId}` };
  }
}

/**
 * Executa a SAGA dentro do próprio processo.
 *
 * Usado em desenvolvimento e nos testes. Em produção o orquestrador é o Step
 * Functions — ver a justificativa em `docs/relatorio-saga.md`.
 */
export class InlineSagaLauncher implements SagaLauncherPort {
  constructor(private readonly orchestrator: PurchaseSagaOrchestrator) {}

  async start(params: {
    orderId: string;
    correlationId: string;
  }): Promise<{ executionRef: string }> {
    await this.orchestrator.run(params);
    return { executionRef: `inline-${params.orderId}` };
  }
}
