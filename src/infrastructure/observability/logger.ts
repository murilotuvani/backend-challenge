import pino from 'pino';
import { currentContext } from './context';

/**
 * Logs estruturados em JSON. O contexto de correlação entra via mixin, então nenhum call site precisa
 * repassar ids. Valores monetários e payloads completos nunca são logados: os paths abaixo são
 * redigidos como defesa extra caso alguém passe um objeto inteiro por engano.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wagering-processor', instance: process.env.INSTANCE_ID ?? process.env.HOSTNAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'msg',
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin: () => ({ ...currentContext() }),
  redact: {
    paths: [
      'money',
      '*.money',
      'amount',
      '*.amount',
      'balance',
      '*.balance',
      'payload',
      '*.payload',
      'body',
      '*.body',
      'authorization',
      '*.authorization',
      'headers.authorization',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
