import { ConflictError, ValidationError } from '../errors/domain-error';
import { Money } from '../value-objects/money';

/**
 * Estado do pedido de compra — é também o estado da SAGA.
 *
 * ```
 *   PENDING
 *      │ reserva do veículo (passo 1)
 *      ▼
 *   VEHICLE_RESERVED
 *      │ validação do comprador (passo 2)
 *      ▼
 *   CUSTOMER_VALIDATED
 *      │ emissão do código de pagamento (passo 3)
 *      ▼
 *   AWAITING_PAYMENT ──── timeout / desistência / recusa ──┐
 *      │ confirmação do pagamento (passo 4)                │
 *      ▼                                                   ▼
 *   PAID                                              COMPENSATING
 *      │ baixa no estoque (passo 5)                        │
 *      ▼                                                   ▼
 *   SALE_CONFIRMED                              CANCELLED | FAILED
 *      │ retirada pelo cliente (passo 6)
 *      ▼
 *   COMPLETED
 * ```
 *
 * Tudo depois de `VEHICLE_RESERVED` precisa de compensação, porque a partir
 * dali existe efeito colateral em outro serviço: a unidade saiu do estoque.
 */
export const OrderStatus = {
  PENDING: 'PENDING',
  VEHICLE_RESERVED: 'VEHICLE_RESERVED',
  CUSTOMER_VALIDATED: 'CUSTOMER_VALIDATED',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PAID: 'PAID',
  SALE_CONFIRMED: 'SALE_CONFIRMED',
  COMPLETED: 'COMPLETED',
  COMPENSATING: 'COMPENSATING',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Estados a partir dos quais nada mais acontece. */
export const TERMINAL_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.FAILED,
];

export const CancellationReason = {
  CUSTOMER_GAVE_UP: 'CUSTOMER_GAVE_UP',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  PAYMENT_REFUSED: 'PAYMENT_REFUSED',
  VEHICLE_UNAVAILABLE: 'VEHICLE_UNAVAILABLE',
  CUSTOMER_NOT_ELIGIBLE: 'CUSTOMER_NOT_ELIGIBLE',
  SYSTEM_FAILURE: 'SYSTEM_FAILURE',
} as const;
export type CancellationReason = (typeof CancellationReason)[keyof typeof CancellationReason];

export const SagaStep = {
  RESERVE_VEHICLE: 'RESERVE_VEHICLE',
  VALIDATE_CUSTOMER: 'VALIDATE_CUSTOMER',
  CREATE_PAYMENT: 'CREATE_PAYMENT',
  AWAIT_PAYMENT: 'AWAIT_PAYMENT',
  CONFIRM_SALE: 'CONFIRM_SALE',
  DELIVER_VEHICLE: 'DELIVER_VEHICLE',
  COMPENSATE_RELEASE_VEHICLE: 'COMPENSATE_RELEASE_VEHICLE',
  COMPENSATE_CANCEL_PAYMENT: 'COMPENSATE_CANCEL_PAYMENT',
} as const;
export type SagaStep = (typeof SagaStep)[keyof typeof SagaStep];

/**
 * Linha do tempo da SAGA.
 *
 * Persistir cada passo — e não apenas o estado corrente — é o que permite
 * responder "por que este pedido falhou" meses depois, e é a base do painel de
 * operação. Uma máquina de estados sem histórico é opaca em produção.
 */
export interface TimelineEntry {
  step: SagaStep;
  outcome: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  at: Date;
  detail: string | null;
}

export interface OrderProps {
  id: string;
  customerId: string;
  vehicleId: string;
  amount: Money | null;
  status: OrderStatus;
  reservationId: string | null;
  reservationExpiresAt: Date | null;
  paymentChargeId: string | null;
  /**
   * Token de callback do Step Functions enquanto a SAGA aguarda o pagamento.
   * É o que permite ao webhook retomar a execução exata que está suspensa.
   * Apagado assim que consumido: um token só vale uma vez.
   */
  sagaTaskToken: string | null;
  paymentCode: string | null;
  paymentCodeExpiresAt: Date | null;
  paidAt: Date | null;
  deliveredAt: Date | null;
  cancellationReason: CancellationReason | null;
  cancellationDetail: string | null;
  timeline: TimelineEntry[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Order {
  private constructor(private props: OrderProps) {}

  static create(input: {
    id: string;
    customerId: string;
    vehicleId: string;
    now: Date;
  }): Order {
    if (!input.customerId || !input.vehicleId) {
      throw new ValidationError('Pedido exige comprador e veículo');
    }

    return new Order({
      id: input.id,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      amount: null,
      status: OrderStatus.PENDING,
      reservationId: null,
      reservationExpiresAt: null,
      paymentChargeId: null,
      sagaTaskToken: null,
      paymentCode: null,
      paymentCodeExpiresAt: null,
      paidAt: null,
      deliveredAt: null,
      cancellationReason: null,
      cancellationDetail: null,
      timeline: [],
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: OrderProps): Order {
    return new Order({ ...props, timeline: [...props.timeline] });
  }

  // ---------------------------------------------------------------------------
  // Passos da SAGA
  // ---------------------------------------------------------------------------

  markVehicleReserved(params: {
    reservationId: string;
    amountInCents: number;
    expiresAt: Date;
    now: Date;
  }): void {
    this.assertNotTerminal();
    // Idempotência: o Step Functions reexecuta passos após timeout de rede.
    if (this.props.status !== OrderStatus.PENDING) {
      if (this.props.reservationId === params.reservationId) return;
      throw new ConflictError('Reserva já registrada em outro estado do pedido', {
        orderId: this.props.id,
        status: this.props.status,
      });
    }

    this.props.reservationId = params.reservationId;
    this.props.amount = Money.fromCents(params.amountInCents);
    this.props.reservationExpiresAt = params.expiresAt;
    this.transition(OrderStatus.VEHICLE_RESERVED, SagaStep.RESERVE_VEHICLE, params.now);
  }

  /**
   * Registra o token de callback recebido do Step Functions.
   *
   * Só faz sentido enquanto o pedido aguarda pagamento; em qualquer outro
   * estado o token seria órfão e a execução correspondente já teria terminado.
   */
  attachSagaTaskToken(token: string, now: Date): void {
    if (this.props.status !== OrderStatus.AWAITING_PAYMENT) {
      throw new ConflictError(
        'Só é possível registrar o token de callback com o pedido aguardando pagamento',
        { orderId: this.props.id, status: this.props.status },
      );
    }
    this.props.sagaTaskToken = token;
    this.touch(now);
  }

  /** Consome o token: devolve-o e o apaga, para que não seja usado duas vezes. */
  consumeSagaTaskToken(now: Date): string | null {
    const token = this.props.sagaTaskToken;
    if (token) {
      this.props.sagaTaskToken = null;
      this.touch(now);
    }
    return token;
  }

  markCustomerValidated(now: Date): void {
    this.assertNotTerminal();
    if (this.props.status === OrderStatus.CUSTOMER_VALIDATED) return;
    this.assertStatus(OrderStatus.VEHICLE_RESERVED, SagaStep.VALIDATE_CUSTOMER);
    this.transition(OrderStatus.CUSTOMER_VALIDATED, SagaStep.VALIDATE_CUSTOMER, now);
  }

  markPaymentCodeIssued(params: {
    chargeId: string;
    paymentCode: string;
    expiresAt: Date;
    now: Date;
  }): void {
    this.assertNotTerminal();
    if (this.props.status === OrderStatus.AWAITING_PAYMENT) {
      if (this.props.paymentChargeId === params.chargeId) return;
      throw new ConflictError('Já existe uma cobrança emitida para este pedido', {
        orderId: this.props.id,
      });
    }
    this.assertStatus(OrderStatus.CUSTOMER_VALIDATED, SagaStep.CREATE_PAYMENT);

    this.props.paymentChargeId = params.chargeId;
    this.props.paymentCode = params.paymentCode;
    this.props.paymentCodeExpiresAt = params.expiresAt;
    this.transition(OrderStatus.AWAITING_PAYMENT, SagaStep.CREATE_PAYMENT, params.now);
  }

  /**
   * Confirmação do pagamento.
   *
   * `source` distingue duas situações que parecem iguais e não são:
   *
   *  - `WEBHOOK`: o provedor avisou agora. Se o aviso chegou depois do prazo, o
   *    pagamento é tardio e **não** conclui a venda — no intervalo a reserva
   *    pode ter vencido e o veículo ter sido vendido a outro comprador. O fluxo
   *    correto é estornar.
   *  - `RECONCILIATION`: a varredura consultou o provedor e ele informou que a
   *    cobrança está paga. Aqui o pagamento é fato consumado — provavelmente
   *    feito dentro do prazo, com o webhook perdido no caminho. Recusar por
   *    causa do próprio relógio puniria um cliente que pagou corretamente. A
   *    proteção contra vender um veículo indisponível continua existindo, mas no
   *    lugar certo: o vehicle-service recusa a baixa se a reserva não estiver
   *    mais ativa, e a SAGA então estorna.
   */
  markPaid(params: {
    now: Date;
    chargeId?: string;
    source?: 'WEBHOOK' | 'RECONCILIATION';
  }): void {
    if (this.props.status === OrderStatus.PAID || this.props.status === OrderStatus.SALE_CONFIRMED) {
      return; // idempotente: o provedor reenvia o webhook
    }
    this.assertNotTerminal();
    this.assertStatus(OrderStatus.AWAITING_PAYMENT, SagaStep.AWAIT_PAYMENT);

    if (params.chargeId && this.props.paymentChargeId !== params.chargeId) {
      throw new ConflictError('A cobrança informada não pertence a este pedido', {
        orderId: this.props.id,
      });
    }
    if ((params.source ?? 'WEBHOOK') === 'WEBHOOK' && this.isPaymentWindowExpired(params.now)) {
      throw new ConflictError('O prazo de pagamento deste pedido já expirou', {
        orderId: this.props.id,
        expiredAt: this.props.paymentCodeExpiresAt?.toISOString(),
      });
    }

    this.props.paidAt = params.now;
    this.transition(OrderStatus.PAID, SagaStep.AWAIT_PAYMENT, params.now);
  }

  markSaleConfirmed(now: Date): void {
    if (this.props.status === OrderStatus.SALE_CONFIRMED) return;
    this.assertNotTerminal();
    this.assertStatus(OrderStatus.PAID, SagaStep.CONFIRM_SALE);
    this.transition(OrderStatus.SALE_CONFIRMED, SagaStep.CONFIRM_SALE, now);
  }

  /** Retirada do veículo pelo cliente — encerra o processo. */
  markDelivered(now: Date): void {
    if (this.props.status === OrderStatus.COMPLETED) return;
    this.assertStatus(OrderStatus.SALE_CONFIRMED, SagaStep.DELIVER_VEHICLE);

    this.props.deliveredAt = now;
    this.transition(OrderStatus.COMPLETED, SagaStep.DELIVER_VEHICLE, now);
  }

  // ---------------------------------------------------------------------------
  // Compensação
  // ---------------------------------------------------------------------------

  /**
   * Desistência pedida pelo cliente (ou pela loja em nome dele).
   *
   * Aceita até o pagamento ser confirmado. A partir daí a SAGA segue para a
   * baixa no estoque — o ponto de não retorno —, e desfazer a compra passa a ser
   * devolução (arrependimento, garantia): um processo da loja, com regras e
   * prazos próprios, e não uma compensação técnica.
   */
  assertCustomerCanGiveUp(): void {
    if (this.props.status === OrderStatus.PAID || this.props.status === OrderStatus.SALE_CONFIRMED) {
      throw new ConflictError(
        'Pagamento já confirmado: a desistência agora é devolução, tratada pela loja',
        { orderId: this.props.id, status: this.props.status },
      );
    }
  }

  /**
   * Entra em compensação. A partir daqui o pedido não avança mais — só desfaz.
   *
   * Separar `beginCompensation` de `finishCompensation` deixa visível, na
   * consulta ao pedido, que existe uma compensação em andamento. Um pedido
   * parado em `COMPENSATING` é um alarme operacional: algo não conseguiu ser
   * desfeito.
   */
  beginCompensation(reason: CancellationReason, detail: string | null, now: Date): boolean {
    if (TERMINAL_STATUSES.includes(this.props.status)) {
      return false;
    }
    if (this.props.status === OrderStatus.COMPENSATING) {
      return true; // já em compensação: reexecutar é permitido
    }
    if (this.props.status === OrderStatus.COMPLETED) {
      throw new ConflictError('Pedido já concluído não pode ser cancelado', {
        orderId: this.props.id,
      });
    }
    if (this.props.status === OrderStatus.SALE_CONFIRMED) {
      // A baixa no estoque é o ponto de não retorno: o vehicle-service recusa
      // liberar um veículo vendido, e a compensação ficaria presa no meio.
      throw new ConflictError('Venda já confirmada: desfazê-la é devolução, não compensação', {
        orderId: this.props.id,
      });
    }

    this.props.cancellationReason = reason;
    this.props.cancellationDetail = detail;
    this.props.status = OrderStatus.COMPENSATING;
    this.touch(now);
    return true;
  }

  recordCompensationStep(step: SagaStep, outcome: TimelineEntry['outcome'], detail: string | null, now: Date): void {
    this.props.timeline.push({ step, outcome, at: now, detail });
    this.touch(now);
  }

  finishCompensation(now: Date): void {
    if (TERMINAL_STATUSES.includes(this.props.status)) return;

    // Encerrado o processo, o token de callback perde a validade.
    this.props.sagaTaskToken = null;

    // Desistência do cliente e timeout são cancelamento; falha de sistema é
    // falha — a distinção importa para o indicador operacional e para o alarme.
    const failed = this.props.cancellationReason === CancellationReason.SYSTEM_FAILURE;
    this.props.status = failed ? OrderStatus.FAILED : OrderStatus.CANCELLED;
    this.touch(now);
  }

  // ---------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------

  /** Passos que precisam ser desfeitos, do mais recente para o mais antigo. */
  compensationsRequired(): SagaStep[] {
    const steps: SagaStep[] = [];
    if (this.props.paymentChargeId) steps.push(SagaStep.COMPENSATE_CANCEL_PAYMENT);
    if (this.props.reservationId) steps.push(SagaStep.COMPENSATE_RELEASE_VEHICLE);
    return steps;
  }

  isPaymentWindowExpired(now: Date): boolean {
    return (
      this.props.paymentCodeExpiresAt !== null &&
      this.props.paymentCodeExpiresAt.getTime() <= now.getTime()
    );
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.props.status);
  }

  get id(): string { return this.props.id; }
  get customerId(): string { return this.props.customerId; }
  get vehicleId(): string { return this.props.vehicleId; }
  get amount(): Money | null { return this.props.amount; }
  get status(): OrderStatus { return this.props.status; }
  get reservationId(): string | null { return this.props.reservationId; }
  get reservationExpiresAt(): Date | null { return this.props.reservationExpiresAt; }
  get paymentChargeId(): string | null { return this.props.paymentChargeId; }
  get sagaTaskToken(): string | null { return this.props.sagaTaskToken; }
  get paymentCode(): string | null { return this.props.paymentCode; }
  get paymentCodeExpiresAt(): Date | null { return this.props.paymentCodeExpiresAt; }
  get paidAt(): Date | null { return this.props.paidAt; }
  get deliveredAt(): Date | null { return this.props.deliveredAt; }
  get cancellationReason(): CancellationReason | null { return this.props.cancellationReason; }
  get cancellationDetail(): string | null { return this.props.cancellationDetail; }
  get timeline(): TimelineEntry[] { return [...this.props.timeline]; }
  get version(): number { return this.props.version; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  toSnapshot(): OrderProps {
    return { ...this.props, timeline: [...this.props.timeline] };
  }

  // ---------------------------------------------------------------------------
  // Invariantes
  // ---------------------------------------------------------------------------

  private transition(status: OrderStatus, step: SagaStep, now: Date): void {
    this.props.status = status;
    this.props.timeline.push({ step, outcome: 'SUCCEEDED', at: now, detail: null });
    this.touch(now);
  }

  private assertStatus(expected: OrderStatus, step: SagaStep): void {
    if (this.props.status !== expected) {
      throw new ConflictError(
        `O passo ${step} exige o pedido em ${expected}, mas ele está em ${this.props.status}`,
        { orderId: this.props.id, status: this.props.status, step },
      );
    }
  }

  private assertNotTerminal(): void {
    if (TERMINAL_STATUSES.includes(this.props.status)) {
      throw new ConflictError('O pedido já está encerrado', {
        orderId: this.props.id,
        status: this.props.status,
      });
    }
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
    this.props.version += 1;
  }
}
