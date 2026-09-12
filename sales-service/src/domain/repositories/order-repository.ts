import { Order, OrderStatus } from '../entities/order';

export interface OrderFilters {
  customerId?: string;
  vehicleId?: string;
  status?: OrderStatus;
}

export interface PageQuery {
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface OrderRepository {
  create(order: Order): Promise<void>;
  update(order: Order, expectedVersion: number): Promise<boolean>;
  findById(id: string): Promise<Order | null>;
  findByPaymentChargeId(chargeId: string): Promise<Order | null>;

  /**
   * Pedido em aberto do mesmo cliente para o mesmo veículo.
   *
   * Impede que um duplo clique no botão "reservar" abra duas SAGAs para a
   * mesma compra — a segunda perderia a disputa de estoque contra a primeira e
   * o cliente veria um erro sem entender por quê.
   */
  findActiveByCustomerAndVehicle(customerId: string, vehicleId: string): Promise<Order | null>;

  list(filters: OrderFilters, page: PageQuery): Promise<Paginated<Order>>;

  /** Pedidos cuja janela de pagamento venceu e que ainda não foram compensados. */
  findExpiredAwaitingPayment(now: Date, limit: number): Promise<Order[]>;
}
