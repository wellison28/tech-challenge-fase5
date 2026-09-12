import { DataAccessLog, DataAccessLogProps } from '../entities/data-access-log';

export interface DataAccessLogRepository {
  /** Somente inserção: a trilha de auditoria não admite alteração nem remoção. */
  append(log: DataAccessLog): Promise<void>;
  listByCustomer(customerId: string, limit: number): Promise<DataAccessLogProps[]>;
}
