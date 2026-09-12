import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SERVICE_NAME: z.string().default('customer-service'),

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
  AUTH_MODE: z.enum(['cognito', 'dev']).default('cognito'),

  CRYPTO_MODE: z.enum(['kms', 'local']).default('kms'),
  KMS_KEY_ID: z.string().optional(),
  LOCAL_MASTER_KEY: z.string().optional(),
  CPF_BLIND_INDEX_PEPPER: z.string().optional(),
  CPF_PEPPER_SECRET_ID: z.string().optional(),
  BLIND_INDEX_VERSION: z.coerce.number().int().positive().default(1),

  PRIVACY_POLICY_VERSION: z.string().default('2026-01'),
  FISCAL_RETENTION_YEARS: z.coerce.number().int().positive().default(5),
  CORS_ALLOWED_ORIGINS: z.string().default('*'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Validação da configuração na inicialização.
 *
 * Neste serviço as travas vão além do formato: modos de desenvolvimento que
 * enfraquecem a criptografia ou a autenticação são **recusados** quando
 * `NODE_ENV=production`. Uma variável de ambiente errada não pode ser a
 * diferença entre CPF cifrado e CPF em claro.
 */
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
    if (env.DB_AUTH_MODE === 'password') {
      throw new Error('DB_AUTH_MODE=password é proibido em produção: use iam');
    }
    if (env.CRYPTO_MODE === 'local') {
      throw new Error('CRYPTO_MODE=local é proibido em produção: use KMS');
    }
  }
  if (env.AUTH_MODE === 'cognito' && !env.COGNITO_ISSUER) {
    throw new Error('AUTH_MODE=cognito exige COGNITO_ISSUER');
  }
  if (env.CRYPTO_MODE === 'kms' && !env.KMS_KEY_ID) {
    throw new Error('CRYPTO_MODE=kms exige KMS_KEY_ID');
  }
  if (env.CRYPTO_MODE === 'local' && !env.LOCAL_MASTER_KEY) {
    throw new Error('CRYPTO_MODE=local exige LOCAL_MASTER_KEY');
  }
  if (!env.CPF_BLIND_INDEX_PEPPER && !env.CPF_PEPPER_SECRET_ID) {
    throw new Error('Informe CPF_BLIND_INDEX_PEPPER ou CPF_PEPPER_SECRET_ID');
  }

  cached = env;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
