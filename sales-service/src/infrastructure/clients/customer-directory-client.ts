import {
  BillingProfile,
  CustomerDirectoryPort,
  EligibilityCheck,
} from '../../application/ports/customer-directory';
import { HttpClient } from './http-client';

/**
 * Adaptador HTTP do customer-service.
 *
 * Cada chamada declara a finalidade no cabeçalho `X-Data-Purpose`, que o
 * customer-service exige e registra na trilha de auditoria. A finalidade é
 * fixa por método: não há como o sales-service reutilizar o token da consulta
 * de elegibilidade para puxar o perfil de cobrança.
 */
export class CustomerDirectoryClient implements CustomerDirectoryPort {
  constructor(private readonly http: HttpClient) {}

  async checkEligibility(params: {
    customerId: string;
    correlationId: string;
  }): Promise<EligibilityCheck> {
    return this.http.send<EligibilityCheck>({
      method: 'GET',
      path: `/internal/customers/${params.customerId}/eligibility`,
      headers: { 'x-data-purpose': 'PURCHASE_SAGA' },
      correlationId: params.correlationId,
      step: 'VALIDATE_CUSTOMER',
    });
  }

  async getBillingProfile(params: {
    customerId: string;
    correlationId: string;
  }): Promise<BillingProfile> {
    return this.http.send<BillingProfile>({
      method: 'GET',
      path: `/internal/customers/${params.customerId}/billing-profile`,
      headers: { 'x-data-purpose': 'PAYMENT_CODE_ISSUANCE' },
      correlationId: params.correlationId,
      step: 'CREATE_PAYMENT',
    });
  }
}
