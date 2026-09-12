import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { SagaCallbackPort } from '../../application/ports/saga-callback';

export class StepFunctionsSagaCallback implements SagaCallbackPort {
  private readonly client: SFNClient;

  constructor(options: { region: string; endpoint?: string }) {
    this.client = new SFNClient({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
  }

  async succeed(params: {
    taskToken: string;
    output: Record<string, unknown>;
  }): Promise<void> {
    await this.client.send(
      new SendTaskSuccessCommand({
        taskToken: params.taskToken,
        output: JSON.stringify(params.output),
      }),
    );
  }

  async fail(params: { taskToken: string; error: string; cause: string }): Promise<void> {
    await this.client.send(
      new SendTaskFailureCommand({
        taskToken: params.taskToken,
        error: params.error,
        cause: params.cause.slice(0, 32_768),
      }),
    );
  }
}

/**
 * No modo inline não existe execução suspensa para retomar: o próprio processo
 * segue para o passo seguinte. O dublê registra a intenção e não faz nada.
 */
export class NoopSagaCallback implements SagaCallbackPort {
  async succeed(): Promise<void> {}
  async fail(): Promise<void> {}
}
