export interface EligibilityCheck {
  customerId: string;
  eligible: boolean;
  reasons: string[];
}

export interface BillingProfile {
  customerId: string;
  fullName: string;
  cpf: string;
  email: string;
  phone: string;
}

/**
 * Porta para o customer-service.
 *
 * `checkEligibility` não devolve dado pessoal — é o que a SAGA usa no caminho
 * normal. `getBillingProfile` devolve, e por isso é chamado uma única vez, no
 * passo de emissão da cobrança, e o resultado **nunca é persistido** por este
 * serviço: vive apenas em memória, o tempo de montar a chamada ao gateway.
 */
export interface CustomerDirectoryPort {
  checkEligibility(params: {
    customerId: string;
    correlationId: string;
  }): Promise<EligibilityCheck>;

  getBillingProfile(params: {
    customerId: string;
    correlationId: string;
  }): Promise<BillingProfile>;
}
