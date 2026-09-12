import { NotFoundError } from '../../domain/errors/domain-error';
import {
  OrderFilters,
  PageQuery,
  Paginated,
} from '../../domain/repositories/order-repository';
import { OrderDTO, toOrderDTO } from '../dto/order-dto';
import { UnitOfWork } from '../ports/unit-of-work';

export class GetOrderUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * O código de pagamento só é devolvido ao próprio comprador.
   *
   * Ele é, na prática, um instrumento de cobrança: exibi-lo a um operador de
   * atendimento permitiria que alguém pagasse — ou divulgasse — a cobrança de
   * outra pessoa.
   */
  async execute(params: { orderId: string; requesterId: string; isStaff: boolean }): Promise<OrderDTO> {
    const order = await this.uow.execute((ctx) => ctx.orders.findById(params.orderId));
    if (!order) {
      throw new NotFoundError('Pedido', params.orderId);
    }
    return toOrderDTO(order, { includePaymentCode: order.customerId === params.requesterId });
  }
}

export class ListOrdersUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(filters: OrderFilters, page: PageQuery): Promise<Paginated<OrderDTO>> {
    const result = await this.uow.execute((ctx) => ctx.orders.list(filters, page));
    return {
      ...result,
      items: result.items.map((order) => toOrderDTO(order, { includePaymentCode: false })),
    };
  }
}
