export interface PaymentCharge {
  chargeId: string;
  /** Código copiável (Pix copia-e-cola ou linha digitável do boleto). */
  paymentCode: string;
  expiresAt: string;
  amountInCents: number;
}

export const PaymentChargeStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  REFUSED: 'REFUSED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentChargeStatus =
  (typeof PaymentChargeStatus)[keyof typeof PaymentChargeStatus];

export interface PaymentGatewayPort {
  /**
   * Passo 3. `idempotencyKey` é o `orderId`: se a rede cair depois de o
   * provedor criar a cobrança mas antes da resposta chegar, a reexecução
   * devolve a mesma cobrança em vez de gerar uma segunda para o mesmo pedido.
   */
  createCharge(params: {
    orderId: string;
    amountInCents: number;
    payer: { fullName: string; cpf: string; email: string };
    expiresInMinutes: number;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<PaymentCharge>;

  /** Compensação do passo 3, para cobrança ainda não paga. */
  cancelCharge(params: { chargeId: string; correlationId: string }): Promise<void>;

  /**
   * Compensação do passo 3, para cobrança já paga: devolve o valor integral.
   *
   * Cancelar uma cobrança paga não devolve o dinheiro. `idempotencyKey` é
   * própria do estorno, para que a reexecução da compensação não estorne duas
   * vezes.
   */
  refundCharge(params: {
    chargeId: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<void>;

  /**
   * Consulta ativa do status.
   *
   * Existe porque webhook não é garantia: a notificação pode se perder, chegar
   * fora de ordem ou ser bloqueada. Um processo agendado confere as cobranças
   * pendentes antes de deixar o pedido expirar por engano.
   */
  getCharge(params: {
    chargeId: string;
    correlationId: string;
  }): Promise<{ chargeId: string; status: PaymentChargeStatus }>;

  /** Valida a assinatura HMAC do webhook contra o segredo compartilhado. */
  verifyWebhookSignature(params: { rawBody: string; signature: string }): boolean;
}
