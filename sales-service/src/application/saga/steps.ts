import { CancellationReason, Order, OrderStatus, SagaStep } from '../../domain/entities/order';
import { ConflictError, NotFoundError, SagaStepError } from '../../domain/errors/domain-error';
import { OrderEventType, OrderPayload } from '../../domain/events/domain-event';
import { EventFactory } from '../events/event-factory';
import { Clock } from '../ports/clock';
import { CustomerDirectoryPort } from '../ports/customer-directory';
import { PaymentGatewayPort } from '../ports/payment-gateway';
import { UnitOfWork } from '../ports/unit-of-work';
import { VehicleCatalogPort } from '../ports/vehicle-catalog';

export interface StepInput {
  orderId: string;
  correlationId: string;
}

export interface StepOutput {
  orderId: string;
  status: OrderStatus;
  /** Presente apenas no passo de emissão da cobrança. */
  paymentCode?: string;
  paymentCodeExpiresAt?: string;
}

/**
 * Passos da SAGA de compra.
 *
 * Cada passo é uma unidade independente, invocável de duas formas:
 *
 *  - como **Lambda Task** de uma máquina de estados do Step Functions
 *    (produção — ver `infra/statemachine/purchase-saga.asl.json`);
 *  - pelo **orquestrador em processo** (`PurchaseSagaOrchestrator`), usado em
 *    desenvolvimento e nos testes.
 *
 * A mesma lógica roda nos dois modos: o que muda é quem decide a ordem dos
 * passos e quem trata o retry. Isso mantém o Step Functions como detalhe de
 * infraestrutura, e não como dependência do código de negócio.
 *
 * Todo passo é **idempotente**: o orquestrador pode reexecutá-lo após um
 * timeout de rede sem duplicar efeito.
 */
export class PurchaseSagaSteps {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly vehicles: VehicleCatalogPort,
    private readonly customers: CustomerDirectoryPort,
    private readonly payments: PaymentGatewayPort,
    private readonly paymentWindowMinutes: number,
  ) {}

  /**
   * Passo 1 — reservar o veículo.
   *
   * É o primeiro de propósito: é o recurso escasso e disputado. Falhar aqui
   * custa barato, porque nada foi feito ainda e não há o que compensar. Se a
   * validação do cliente viesse antes, uma disputa perdida jogaria fora o
   * trabalho já realizado — e, pior, aumentaria a janela em que outro cliente
   * poderia levar o carro.
   */
  async reserveVehicle(input: StepInput): Promise<StepOutput> {
    const order = await this.loadOrder(input.orderId);

    let reservation;
    try {
      reservation = await this.vehicles.reserve({
        vehicleId: order.vehicleId,
        customerId: order.customerId,
        orderId: order.id,
        correlationId: input.correlationId,
      });
    } catch (error) {
      // 409 = outro cliente reservou antes. Não adianta tentar de novo.
      if (error instanceof SagaStepError && !error.retryable) {
        throw new SagaStepError(
          SagaStep.RESERVE_VEHICLE,
          'Veículo indisponível: outro cliente o reservou primeiro',
          false,
          { orderId: order.id, cancellationReason: CancellationReason.VEHICLE_UNAVAILABLE },
        );
      }
      throw error;
    }

    return this.persist(order, input.correlationId, (current, now) => {
      current.markVehicleReserved({
        reservationId: reservation.reservationId,
        amountInCents: reservation.priceInCents,
        expiresAt: new Date(reservation.expiresAt),
        now,
      });
      return {
        eventType: OrderEventType.VEHICLE_RESERVED,
        extra: { amountInCents: reservation.priceInCents },
      };
    });
  }

  /**
   * Passo 2 — validar o comprador.
   *
   * Requisito do enunciado: a venda só pode ocorrer para comprador cadastrado.
   * A verificação devolve apenas um veredito; nenhum dado pessoal entra neste
   * serviço nesta etapa.
   */
  async validateCustomer(input: StepInput): Promise<StepOutput> {
    const order = await this.loadOrder(input.orderId);

    const eligibility = await this.customers.checkEligibility({
      customerId: order.customerId,
      correlationId: input.correlationId,
    });

    if (!eligibility.eligible) {
      throw new SagaStepError(
        SagaStep.VALIDATE_CUSTOMER,
        `Comprador não habilitado: ${eligibility.reasons.join(', ')}`,
        false,
        { orderId: order.id, cancellationReason: CancellationReason.CUSTOMER_NOT_ELIGIBLE },
      );
    }

    return this.persist(order, input.correlationId, (current, now) => {
      current.markCustomerValidated(now);
      return { eventType: null };
    });
  }

  /**
   * Passo 3 — emitir o código de pagamento.
   *
   * É o único ponto do sales-service que toca dado pessoal. O perfil do
   * pagador é obtido, repassado ao gateway e descartado: não é gravado em
   * banco, não entra em evento e não aparece em log (ver a redação no logger).
   *
   * A janela de pagamento é deliberadamente menor que o TTL da reserva no
   * vehicle-service — a compensação precisa acontecer antes de o veículo voltar
   * sozinho à vitrine, ou dois caminhos estariam liberando a mesma reserva.
   */
  async createPayment(input: StepInput): Promise<StepOutput> {
    const order = await this.loadOrder(input.orderId);

    if (!order.amount) {
      throw new SagaStepError(SagaStep.CREATE_PAYMENT, 'Pedido sem valor definido', false, {
        orderId: order.id,
      });
    }

    const payer = await this.customers.getBillingProfile({
      customerId: order.customerId,
      correlationId: input.correlationId,
    });

    const charge = await this.payments.createCharge({
      orderId: order.id,
      amountInCents: order.amount.cents,
      payer: { fullName: payer.fullName, cpf: payer.cpf, email: payer.email },
      expiresInMinutes: this.paymentWindowMinutes,
      // O próprio id do pedido: reexecutar o passo devolve a mesma cobrança.
      idempotencyKey: order.id,
      correlationId: input.correlationId,
    });

    return this.persist(order, input.correlationId, (current, now) => {
      current.markPaymentCodeIssued({
        chargeId: charge.chargeId,
        paymentCode: charge.paymentCode,
        expiresAt: new Date(charge.expiresAt),
        now,
      });
      return { eventType: OrderEventType.PAYMENT_CODE_ISSUED };
    });
  }

  /**
   * Passo 5 — confirmar a venda e dar baixa no estoque.
   *
   * Só roda depois do pagamento confirmado. Se o vehicle-service recusar
   * (reserva expirada no intervalo), o erro é definitivo e a SAGA vai para
   * compensação com estorno — vender um carro que já voltou à vitrine seria
   * pior do que devolver o dinheiro.
   */
  async confirmSale(input: StepInput): Promise<StepOutput> {
    const order = await this.loadOrder(input.orderId);

    // Reexecução do passo: a baixa já aconteceu. Repetir a chamada remota não
    // acrescenta nada e, pior, seria recusada — a unidade não está mais
    // reservada, e sim vendida.
    if (order.status === OrderStatus.SALE_CONFIRMED || order.status === OrderStatus.COMPLETED) {
      return { orderId: order.id, status: order.status };
    }

    await this.vehicles.confirmSale({
      vehicleId: order.vehicleId,
      orderId: order.id,
      customerId: order.customerId,
      correlationId: input.correlationId,
    });

    return this.persist(order, input.correlationId, (current, now) => {
      current.markSaleConfirmed(now);
      return { eventType: OrderEventType.SALE_CONFIRMED };
    });
  }

  /**
   * Liquidação de um pagamento descoberto pela varredura de reconciliação.
   *
   * Marca o pedido como pago e segue para a baixa no estoque. É o caminho do
   * webhook perdido: o cliente pagou, o aviso não chegou, e a janela venceu. A
   * venda só se concretiza se o vehicle-service ainda aceitar a baixa — se a
   * reserva tiver caído no intervalo, o erro é definitivo e a compensação
   * (com estorno) assume.
   */
  async settleReconciledPayment(input: StepInput): Promise<StepOutput> {
    const order = await this.loadOrder(input.orderId);

    if (order.status === OrderStatus.SALE_CONFIRMED || order.status === OrderStatus.COMPLETED) {
      return { orderId: order.id, status: order.status };
    }

    await this.persist(order, input.correlationId, (current, now) => {
      const alreadyPaid = current.paidAt !== null;
      current.markPaid({ now, source: 'RECONCILIATION' });
      return { eventType: alreadyPaid ? null : OrderEventType.PAID };
    });

    return this.confirmSale(input);
  }

  /**
   * Compensação.
   *
   * Executa, na ordem inversa, o desfazimento de tudo que produziu efeito:
   * cancela a cobrança e libera a reserva. Ambos os parceiros expõem operações
   * idempotentes, então reexecutar a compensação é seguro — e necessário,
   * porque ela também pode falhar no meio.
   *
   * Uma compensação que não completa deixa o pedido em `COMPENSATING`, que é
   * um estado observável e alarmado: é preferível um pedido visivelmente preso
   * a um veículo silenciosamente fora do estoque.
   */
  async compensate(
    input: StepInput & { reason: CancellationReason; detail?: string },
  ): Promise<StepOutput> {
    const order = await this.loadOrder(input.orderId);

    if (order.isTerminal) {
      return { orderId: order.id, status: order.status };
    }

    const started = await this.uow.execute(async (ctx) => {
      const current = await ctx.orders.findById(input.orderId);
      if (!current) throw new NotFoundError('Pedido', input.orderId);

      const version = current.version;
      if (!current.beginCompensation(input.reason, input.detail ?? null, this.clock.now())) {
        return false;
      }
      if (!(await ctx.orders.update(current, version))) {
        throw new ConflictError('Conflito de concorrência ao iniciar a compensação', {
          orderId: input.orderId,
        });
      }
      return true;
    });

    if (!started) {
      const finished = await this.loadOrder(input.orderId);
      return { orderId: finished.id, status: finished.status };
    }

    const pending = order.compensationsRequired();
    const failures: string[] = [];

    for (const step of pending) {
      try {
        if (step === SagaStep.COMPENSATE_CANCEL_PAYMENT && order.paymentChargeId) {
          await this.payments.cancelCharge({
            chargeId: order.paymentChargeId,
            correlationId: input.correlationId,
          });
        }
        if (step === SagaStep.COMPENSATE_RELEASE_VEHICLE) {
          await this.vehicles.releaseReservation({
            vehicleId: order.vehicleId,
            orderId: order.id,
            reservationId: order.reservationId,
            reason:
              input.reason === CancellationReason.CUSTOMER_GAVE_UP
                ? 'CUSTOMER_GAVE_UP'
                : input.reason === CancellationReason.PAYMENT_REFUSED ||
                    input.reason === CancellationReason.PAYMENT_TIMEOUT
                  ? 'PAYMENT_FAILED'
                  : 'SAGA_COMPENSATION',
            correlationId: input.correlationId,
          });
        }
        await this.recordCompensation(input.orderId, step, 'SUCCEEDED', null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${step}: ${message}`);
        await this.recordCompensation(input.orderId, step, 'FAILED', message);
      }
    }

    if (failures.length > 0) {
      // Permanece em COMPENSATING para ser reprocessado e alarmado.
      throw new SagaStepError(
        SagaStep.COMPENSATE_RELEASE_VEHICLE,
        `Compensação incompleta: ${failures.join(' | ')}`,
        true,
        { orderId: input.orderId },
      );
    }

    return this.persist(order, input.correlationId, (current, now) => {
      current.finishCompensation(now);
      return {
        eventType:
          current.status === OrderStatus.FAILED ? OrderEventType.FAILED : OrderEventType.CANCELLED,
        extra: { reason: input.reason },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Infraestrutura interna dos passos
  // ---------------------------------------------------------------------------

  private async loadOrder(orderId: string): Promise<Order> {
    const order = await this.uow.execute((ctx) => ctx.orders.findById(orderId));
    if (!order) {
      throw new NotFoundError('Pedido', orderId);
    }
    return order;
  }

  /**
   * Recarrega o pedido dentro da transação, aplica a mutação e grava com trava
   * otimista, enfileirando o evento no mesmo commit.
   *
   * Recarregar é essencial: entre a chamada ao parceiro (que pode levar
   * segundos) e a gravação, o pedido pode ter sido cancelado pelo cliente.
   */
  private async persist(
    order: Order,
    correlationId: string,
    mutate: (
      current: Order,
      now: Date,
    ) => { eventType: OrderEventType | null; extra?: Record<string, unknown> },
  ): Promise<StepOutput> {
    return this.uow.execute(async (ctx) => {
      const current = await ctx.orders.findById(order.id);
      if (!current) throw new NotFoundError('Pedido', order.id);

      const version = current.version;
      const now = this.clock.now();
      const { eventType, extra } = mutate(current, now);

      if (!(await ctx.orders.update(current, version))) {
        throw new ConflictError('Conflito de concorrência ao gravar o passo da SAGA', {
          orderId: current.id,
        });
      }

      if (eventType) {
        await ctx.outbox.enqueue(
          this.events.build<OrderPayload>(
            eventType,
            current.id,
            {
              orderId: current.id,
              customerId: current.customerId,
              vehicleId: current.vehicleId,
              status: current.status,
              ...(current.amount ? { amountInCents: current.amount.cents } : {}),
              ...extra,
            },
            correlationId,
          ),
        );
      }

      return {
        orderId: current.id,
        status: current.status,
        ...(current.paymentCode ? { paymentCode: current.paymentCode } : {}),
        ...(current.paymentCodeExpiresAt
          ? { paymentCodeExpiresAt: current.paymentCodeExpiresAt.toISOString() }
          : {}),
      };
    });
  }

  private async recordCompensation(
    orderId: string,
    step: SagaStep,
    outcome: 'SUCCEEDED' | 'FAILED',
    detail: string | null,
  ): Promise<void> {
    await this.uow.execute(async (ctx) => {
      const current = await ctx.orders.findById(orderId);
      if (!current) return;

      const version = current.version;
      current.recordCompensationStep(step, outcome, detail, this.clock.now());
      await ctx.orders.update(current, version);
    });
  }
}
