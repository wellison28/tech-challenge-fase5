import { VehicleStatus } from '../../domain/entities/vehicle';
import {
  Paginated,
  SortDirection,
  VehicleFilters,
  VehicleSortField,
} from '../../domain/repositories/vehicle-repository';
import { VehicleDTO, toPublicVehicleDTO } from '../dto/vehicle-dto';
import { UnitOfWork } from '../ports/unit-of-work';

export interface ListVehiclesQuery extends VehicleFilters {
  page?: number;
  pageSize?: number;
  sortBy?: VehicleSortField;
  sortDirection?: SortDirection;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class ListVehiclesUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Listagem genérica com filtros. O requisito de negócio ("à venda" e
   * "vendidos", ambos do mais barato para o mais caro) é atendido pelos atalhos
   * `listAvailable`/`listSold`, que fixam status e ordenação — o endpoint
   * genérico existe para o time de frontend montar busca e filtros na vitrine.
   */
  async execute(query: ListVehiclesQuery): Promise<Paginated<VehicleDTO>> {
    const { page, pageSize, sortBy, sortDirection, ...filters } = query;

    const result = await this.uow.execute((ctx) =>
      ctx.vehicles.list(filters, {
        page: Math.max(1, page ?? 1),
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize ?? DEFAULT_PAGE_SIZE)),
        sortBy: sortBy ?? 'price',
        sortDirection: sortDirection ?? 'asc',
      }),
    );

    return { ...result, items: result.items.map(toPublicVehicleDTO) };
  }

  /** Requisito: veículos à venda, do mais barato para o mais caro. */
  async listAvailable(query: Omit<ListVehiclesQuery, 'status' | 'sortBy' | 'sortDirection'>) {
    return this.execute({
      ...query,
      status: VehicleStatus.AVAILABLE,
      sortBy: 'price',
      sortDirection: 'asc',
    });
  }

  /** Requisito: veículos vendidos, do mais barato para o mais caro. */
  async listSold(query: Omit<ListVehiclesQuery, 'status' | 'sortBy' | 'sortDirection'>) {
    return this.execute({
      ...query,
      status: VehicleStatus.SOLD,
      sortBy: 'price',
      sortDirection: 'asc',
    });
  }
}
