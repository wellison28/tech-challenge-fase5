import { Customer, CustomerStatus } from '../entities/customer';
import { Cpf } from '../value-objects/cpf';
import { Email } from '../value-objects/email';

export interface CustomerFilters {
  status?: CustomerStatus;
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

/**
 * Porta de persistência do agregado.
 *
 * A busca recebe o value object (`Cpf`, `Email`), não um índice pré-calculado:
 * criptografia e índice cego são detalhe do adaptador, e a camada de aplicação
 * não precisa — nem deve — saber que existem. Trocar KMS por outro provedor de
 * chaves não altera uma linha de caso de uso.
 */
export interface CustomerRepository {
  create(customer: Customer): Promise<void>;

  /** Trava otimista: o UPDATE só se aplica se a versão em banco for a lida. */
  update(customer: Customer, expectedVersion: number): Promise<boolean>;

  findById(id: string): Promise<Customer | null>;
  findByCpf(cpf: Cpf): Promise<Customer | null>;
  findByEmail(email: Email): Promise<Customer | null>;

  list(filters: CustomerFilters, page: PageQuery): Promise<Paginated<Customer>>;
}
