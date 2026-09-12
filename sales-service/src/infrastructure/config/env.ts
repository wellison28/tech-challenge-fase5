import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3003),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SERVICE_NAME: z.string().default('sales-service'),

  DATABASE_URL: z.string().url(),

  AWS_REGION: z.string().default('us-east-1'),
  EVENT_BUS_NAME: z.string().default('revenda-bus'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  PURCHASE_SAGA_STATE_MACHINE_ARN: z.string().optional(),
  /** `stepfunctions` em produção; `inline` para desenvolvimento e testes. */
  SAGA_MODE: z.enum(['stepfunctions', 'inline']).default('stepfunctions'),

  VEHICLE_SERVICE_URL: z.string().url(),
  CUSTOMER_SERVICE_URL: z.string().url(),
  PARTNER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  PARTNER_MAX_RETRIES: z.coerce.number().int().min(1).max(5).default(3),

  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_ISSUER: z.string().optional(),
  JWT_DEV_SECRET: z.string().optional(),
  AUTH_MODE: z.enum(['cognito', 'dev']).default('cognito'),
  M2M_CLIENT_ID: z.string().optional(),
  M2M_CLIENT_SECRET: z.string().optional(),
  M2M_TOKEN_URL: z.string().url().optional(),

  PAYMENT_PROVIDER: z.enum(['http', 'fake']).default('http'),
  PAYMENT_API_URL: z.string().url().optional(),
  PAYMENT_API_KEY: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(8),

  PAYMENT_WINDOW_MINUTES: z.coerce.number().int().positive().default(25),
  /**
   * Espelha `RESERVATION_TTL_MINUTES` do vehicle-service. Serve só para a
   * validação de coerência abaixo.
   */
  VEHICLE_RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  CORS_ALLOWED_ORIGINS: z.string().default('*'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (env.AUTH_MODE === 'dev') {
      throw new Error('AUTH_MODE=dev é proibido em produção');
    }
    if (env.PAYMENT_PROVIDER === 'fake') {
      throw new Error('PAYMENT_PROVIDER=fake é proibido em produção');
    }
    if (env.SAGA_MODE === 'inline') {
      throw new Error(
        'SAGA_MODE=inline é proibido em produção: a orquestração deve rodar no Step Functions',
      );
    }
  }
  if (env.SAGA_MODE === 'stepfunctions' && !env.PURCHASE_SAGA_STATE_MACHINE_ARN) {
    throw new Error('SAGA_MODE=stepfunctions exige PURCHASE_SAGA_STATE_MACHINE_ARN');
  }
  if (env.PAYMENT_PROVIDER === 'http' && !env.PAYMENT_API_URL) {
    throw new Error('PAYMENT_PROVIDER=http exige PAYMENT_API_URL');
  }

  /**
   * Invariante entre serviços: a janela de pagamento tem de terminar ANTES de
   * a reserva expirar. Se fosse maior, o veículo voltaria sozinho à vitrine
   * enquanto o pedido ainda aceitasse pagamento — e dois compradores poderiam
   * pagar pelo mesmo carro.
   */
  if (env.PAYMENT_WINDOW_MINUTES >= env.VEHICLE_RESERVATION_TTL_MINUTES) {
    throw new Error(
      `PAYMENT_WINDOW_MINUTES (${env.PAYMENT_WINDOW_MINUTES}) deve ser menor que ` +
        `VEHICLE_RESERVATION_TTL_MINUTES (${env.VEHICLE_RESERVATION_TTL_MINUTES})`,
    );
  }

  cached = env;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
