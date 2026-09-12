import { ValidationError } from '../errors/domain-error';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_LENGTH = 254; // RFC 5321

/** E-mail: canal de notificação do processo de compra e dado pessoal. */
export class Email {
  private constructor(readonly value: string) {}

  static create(raw: string): Email {
    const normalized = (raw ?? '').trim().toLowerCase();

    if (normalized.length === 0 || normalized.length > MAX_LENGTH) {
      throw new ValidationError('E-mail deve ter entre 1 e 254 caracteres');
    }
    if (!EMAIL_PATTERN.test(normalized)) {
      throw new ValidationError('E-mail em formato inválido');
    }

    return new Email(normalized);
  }

  /** `jo***@exemplo.com` — usado em log e em resposta de API. */
  mask(): string {
    const [local = '', domain = ''] = this.value.split('@');
    const visible = local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }
}
