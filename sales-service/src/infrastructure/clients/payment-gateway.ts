import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  PaymentCharge,
  PaymentChargeStatus,
  PaymentGatewayPort,
} from '../../application/ports/payment-gateway';
import { HttpClient } from './http-client';

/**
 * Adaptador do provedor de pagamento.
 *
 * `Idempotency-Key` é o id do pedido: se a resposta se perder depois de o
 * provedor criar a cobrança, a reexecução do passo devolve a mesma cobrança em
 * vez de gerar uma segunda para a mesma compra — que seria cobrada em dobro do
 * cliente.
 */
export class HttpPaymentGateway implements PaymentGatewayPort {
  constructor(
    private readonly http: HttpClient,
    private readonly webhookSecret: string,
  ) {}

  async createCharge(params: {
    orderId: string;
    amountInCents: number;
    payer: { fullName: string; cpf: string; email: string };
    expiresInMinutes: number;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<PaymentCharge> {
    return this.http.send<PaymentCharge>({
      method: 'POST',
      path: '/charges',
      headers: { 'idempotency-key': params.idempotencyKey },
      body: {
        referenceId: params.orderId,
        amountInCents: params.amountInCents,
        expiresInMinutes: params.expiresInMinutes,
        payer: params.payer,
      },
      correlationId: params.correlationId,
      step: 'CREATE_PAYMENT',
    });
  }

  async cancelCharge(params: { chargeId: string; correlationId: string }): Promise<void> {
    await this.http.send({
      method: 'POST',
      path: `/charges/${params.chargeId}/cancellation`,
      correlationId: params.correlationId,
      step: 'COMPENSATE_CANCEL_PAYMENT',
    });
  }

  async getCharge(params: {
    chargeId: string;
    correlationId: string;
  }): Promise<{ chargeId: string; status: PaymentChargeStatus }> {
    return this.http.send({
      method: 'GET',
      path: `/charges/${params.chargeId}`,
      correlationId: params.correlationId,
      step: 'AWAIT_PAYMENT',
    });
  }

  /**
   * Valida a assinatura HMAC-SHA256 do webhook.
   *
   * Sem isso, o endpoint de confirmação de pagamento seria público e qualquer
   * um poderia declarar um pedido como pago — levando um carro sem pagar. A
   * comparação é em tempo constante para não vazar a assinatura correta por
   * diferença de temporização.
   */
  verifyWebhookSignature(params: { rawBody: string; signature: string }): boolean {
    const expected = createHmac('sha256', this.webhookSecret)
      .update(params.rawBody)
      .digest('hex');

    const received = Buffer.from(params.signature.replace(/^sha256=/, ''), 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    return received.length === computed.length && timingSafeEqual(received, computed);
  }
}

/**
 * Provedor simulado, para desenvolvimento local e testes.
 *
 * Mantém o mesmo contrato e a mesma verificação de assinatura do adaptador
 * real: um teste que passa contra ele exercita o mesmo caminho de código do
 * webhook em produção.
 */
export class FakePaymentGateway implements PaymentGatewayPort {
  private readonly charges = new Map<
    string,
    { status: PaymentChargeStatus; orderId: string; amountInCents: number }
  >();
  private readonly byIdempotencyKey = new Map<string, PaymentCharge>();

  /**
   * `now` é injetável para que o prazo da cobrança acompanhe o relógio da
   * aplicação. Sem isso, um teste que adianta o relógio simulado não veria a
   * cobrança expirar — e o cenário de timeout ficaria sem cobertura.
   */
  constructor(
    private readonly webhookSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createCharge(params: {
    orderId: string;
    amountInCents: number;
    expiresInMinutes: number;
    idempotencyKey: string;
  }): Promise<PaymentCharge> {
    const existing = this.byIdempotencyKey.get(params.idempotencyKey);
    if (existing) return existing;

    const chargeId = `chg_${randomUUID()}`;
    const charge: PaymentCharge = {
      chargeId,
      paymentCode: `00020126${chargeId.replace(/-/g, '').slice(0, 30).toUpperCase()}5204000053039865802BR`,
      expiresAt: new Date(this.now().getTime() + params.expiresInMinutes * 60_000).toISOString(),
      amountInCents: params.amountInCents,
    };

    this.charges.set(chargeId, {
      status: PaymentChargeStatus.PENDING,
      orderId: params.orderId,
      amountInCents: params.amountInCents,
    });
    this.byIdempotencyKey.set(params.idempotencyKey, charge);
    return charge;
  }

  async cancelCharge(params: { chargeId: string }): Promise<void> {
    const charge = this.charges.get(params.chargeId);
    if (charge && charge.status === PaymentChargeStatus.PENDING) {
      charge.status = PaymentChargeStatus.CANCELLED;
    }
  }

  async getCharge(params: {
    chargeId: string;
  }): Promise<{ chargeId: string; status: PaymentChargeStatus }> {
    return {
      chargeId: params.chargeId,
      status: this.charges.get(params.chargeId)?.status ?? PaymentChargeStatus.EXPIRED,
    };
  }

  verifyWebhookSignature(params: { rawBody: string; signature: string }): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(params.rawBody).digest('hex');
    const received = Buffer.from(params.signature.replace(/^sha256=/, ''), 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    return received.length === computed.length && timingSafeEqual(received, computed);
  }

  /** Só para testes e para o ambiente local: simula o pagamento do cliente. */
  simulatePayment(chargeId: string): void {
    const charge = this.charges.get(chargeId);
    if (charge) charge.status = PaymentChargeStatus.PAID;
  }

  /** Gera a assinatura que o provedor enviaria — usada nos testes do webhook. */
  signPayload(rawBody: string): string {
    return `sha256=${createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')}`;
  }
}
