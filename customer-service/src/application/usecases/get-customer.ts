import { DataAccessAction } from '../../domain/entities/data-access-log';
import { NotFoundError } from '../../domain/errors/domain-error';
import { AuditRecorder } from '../audit/audit-recorder';
import { MaskedCustomerDTO, toMaskedCustomerDTO } from '../dto/customer-dto';
import { AccessContext } from '../ports/access-context';
import { UnitOfWork } from '../ports/unit-of-work';

export class GetCustomerUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * Leitura mascarada. Também é auditada: saber quem consultou o cadastro de um
   * titular importa mesmo quando o dado saiu mascarado — é o que revela varredura
   * de base por uma conta comprometida.
   */
  async execute(customerId: string, context: AccessContext): Promise<MaskedCustomerDTO> {
    return this.uow.execute(async (ctx) => {
      const customer = await ctx.customers.findById(customerId);
      if (!customer) {
        throw new NotFoundError('Cliente', customerId);
      }

      await this.audit.allowed(ctx.auditLog, {
        customerId,
        action: DataAccessAction.READ_MASKED,
        context,
      });

      return toMaskedCustomerDTO(customer);
    });
  }
}
