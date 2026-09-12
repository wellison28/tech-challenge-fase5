import pino from 'pino';

/**
 * Campos que nunca devem aparecer em log. O vehicle-service não trata dado
 * pessoal sensível, mas recebe `customerId` e cabeçalhos de autenticação nas
 * chamadas da SAGA; a redação é aplicada por padrão para que uma mudança
 * futura no payload não vaze nada por descuido.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.cpf',
  '*.password',
  '*.token',
];

export function createLogger(options: { level: string; serviceName: string; env: string }) {
  return pino({
    level: options.level,
    base: { service: options.serviceName, env: options.env },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
