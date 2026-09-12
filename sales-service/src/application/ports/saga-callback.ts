/**
 * Retomada de uma execução suspensa da SAGA.
 *
 * No estado `AguardarPagamento` a máquina de estados fica parada em
 * `waitForTaskToken`: nenhuma computação é consumida enquanto o cliente decide
 * se paga. Quando o webhook chega — ou quando o cliente desiste — é por esta
 * porta que a execução é retomada.
 *
 * `fail` carrega um nome de erro que a máquina de estados casa nos `Catch`
 * (`PagamentoRecusado`, `ClienteDesistiu`), o que faz a rota de compensação
 * registrar o motivo correto no pedido.
 */
export interface SagaCallbackPort {
  succeed(params: { taskToken: string; output: Record<string, unknown> }): Promise<void>;
  fail(params: { taskToken: string; error: string; cause: string }): Promise<void>;
}
