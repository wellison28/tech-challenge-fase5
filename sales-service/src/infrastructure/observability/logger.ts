import pino from 'pino';

/**
 * O sales-service toca dado pessoal em um único ponto: o perfil do pagador,
 * obtido no passo de emissão da cobrança e descartado em seguida. A redação
 * cobre esses campos e o código de pagamento — que é um instrumento de
 * cobrança e não deve circular em log.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  '*.cpf',
  '*.fullName',
  '*.email',
  '*.phone',
  '*.payer',
  '*.paymentCode',
  'payload.paymentCode',
];

export function createLogger(options: { level: string; serviceName: string; env: string }) {
  return pino({
    level: options.level,
    base: { service: options.serviceName, env: options.env },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type Logger = ReturnType<typeof createLogger>;
