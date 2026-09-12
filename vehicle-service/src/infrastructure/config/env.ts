import { z } from 'zod';

/**
 * Validação da configuração na inicialização (fail fast).
 *
 * Uma Lambda que sobe com variável de ambiente faltando só quebra na primeira
 * requisição do usuário. Validar aqui transforma erro de configuração em falha
 * de deploy, que é onde ele custa menos.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SERVICE_NAME: z.string().default('vehicle-service'),

  DATABASE_URL: z.string().url(),
  /**
   * `iam` gera um token IAM a cada conexão ao RDS Proxy — é o modo de produção.
   * `password` usa a senha da DATABASE_URL, para desenvolvimento e testes.
   */
  DB_AUTH_MODE: z.enum(['password', 'iam']).default('password'),

  AWS_REGION: z.string().default('us-east-1'),
  EVENT_BUS_NAME: z.string().default('revenda-bus'),
  AWS_ENDPOINT_URL: z.string().url().optional(),

  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_ISSUER: z.string().optional(),
  JWT_DEV_SECRET: z.string().optional(),
  /**
   * `cognito` valida a assinatura RS256 contra o JWKS do User Pool.
   * `dev` aceita HS256 com segredo local — só para desenvolvimento e testes.
   */
  AUTH_MODE: z.enum(['cognito', 'dev']).default('cognito'),

  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(30),
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

  if (parsed.data.AUTH_MODE === 'dev' && parsed.data.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=dev é proibido em produção');
  }
  if (parsed.data.DB_AUTH_MODE === 'password' && parsed.data.NODE_ENV === 'production') {
    throw new Error('DB_AUTH_MODE=password é proibido em produção: use iam');
  }
  if (parsed.data.AUTH_MODE === 'cognito' && !parsed.data.COGNITO_ISSUER) {
    throw new Error('AUTH_MODE=cognito exige COGNITO_ISSUER');
  }

  cached = parsed.data;
  return cached;
}

/** Somente para testes: descarta o cache entre cenários. */
export function resetEnvCache(): void {
  cached = undefined;
}
