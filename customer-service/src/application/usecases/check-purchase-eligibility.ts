import { DataAccessAction } from '../../domain/entities/data-access-log';
import { NotFoundError } from '../../domain/errors/domain-error';
import { AuditRecorder } from '../audit/audit-recorder';
import { AccessContext } from '../ports/access-context';
import { Clock } from '../ports/clock';
import { UnitOfWork } from '../ports/unit-of-work';

export interface EligibilityResult {
  customerId: string;
  eligible: boolean;
  /** Códigos estáveis (ex.: `EMAIL_NAO_VERIFICADO`) para o frontend traduzir. */
  reasons: string[];
}

/**
 * Passo 2 da SAGA: "efetuar a venda somente para compradores cadastrados".
 *
 * Devolve apenas um booleano e códigos de motivo — nenhum dado pessoal. É a
 * aplicação do princípio da necessidade: a SAGA precisa decidir se prossegue,
 * não precisa saber quem é a pessoa.
 */
export class CheckPurchaseEligibilityUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
  ) {}

  async execute(customerId: string, context: AccessContext): Promise<EligibilityResult> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(customerId);
      if (!customer) {
        // Registra a tentativa: consultas repetidas a ids inexistentes são
        // sinal de enumeração de cadastro.
        await this.audit.denied(ctx.auditLog, {
          customerId,
          action: DataAccessAction.ELIGIBILITY_CHECK,
          reason: 'CLIENTE_NAO_ENCONTRADO',
          context,
        });
        throw new NotFoundError('Cliente', customerId);
      }

      const result = customer.checkPurchaseEligibility(this.clock.now());

      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.ELIGIBILITY_CHECK,
        context,
      });

      return { customerId, eligible: result.eligible, reasons: result.reasons };
    });
  }
}
