import pino from 'pino';

/**
 * Caminhos redigidos no log.
 *
 * Log é o vazamento de dado pessoal mais comum e mais silencioso: vai para o
 * CloudWatch, é copiado para ferramentas de observabilidade, fica retido por
 * meses e é lido por muito mais gente do que o banco. Neste serviço a redação
 * é agressiva e cobre o corpo da requisição inteiro — se um campo novo for
 * adicionado ao cadastro amanhã, ele já nasce protegido.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body',
  'res.body',
  '*.cpf',
  '*.cpfFormatted',
  '*.fullName',
  '*.birthDate',
  '*.email',
  '*.phone',
  '*.address',
  '*.identityDocument',
  '*.password',
  '*.token',
  'payload.cpf',
  'payload.email',
  'customer.cpf',
  'customer.email',
];

export function createLogger(options: { level: string; serviceName: string; env: string }) {
  return pino({
    level: options.level,
    base: { service: options.serviceName, env: options.env },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: {
      // Corpo de requisição nunca é logado; a URL é logada sem query string,
      // porque é comum um CPF acabar num parâmetro de busca.
      req(request: { method?: string; url?: string; id?: string }) {
        return {
          method: request.method,
          url: request.url?.split('?')[0],
          id: request.id,
        };
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
