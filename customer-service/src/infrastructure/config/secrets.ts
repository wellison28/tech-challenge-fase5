import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * Leitura de segredos do AWS Secrets Manager.
 *
 * O pepper do índice cego e a senha do banco não ficam em variável de ambiente
 * da Lambda: variáveis de ambiente aparecem no console, na descrição da função
 * (`GetFunctionConfiguration`) e em qualquer despejo de diagnóstico. O
 * Secrets Manager mantém o valor cifrado com KMS, registra cada leitura no
 * CloudTrail e permite rotação automática.
 *
 * O valor é cacheado no escopo do módulo: a Lambda reutiliza o container entre
 * invocações, então uma leitura por cold start basta.
 */
const cache = new Map<string, string>();

export async function getSecret(
  secretId: string,
  options: { region: string; endpoint?: string },
): Promise<string> {
  const cached = cache.get(secretId);
  if (cached) return cached;

  const client = new SecretsManagerClient({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });

  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = response.SecretString;
  if (!value) {
    throw new Error(`Segredo ${secretId} não possui SecretString`);
  }

  cache.set(secretId, value);
  return value;
}

/** Usado nos testes e após uma rotação forçada. */
export function clearSecretCache(): void {
  cache.clear();
}
