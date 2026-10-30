import { TransientInfrastructureError, UniqueConstraintRaceError } from '../../application/errors';

/** SQLSTATEs em que repetir a operação inteira é seguro e tem chance de dar certo. */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

const TRANSIENT_NETWORK = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|Connection terminated|connect ECONN|Timeout acquiring a connection|Client has encountered a connection error|terminating connection/i;

interface PgLikeError {
  code?: string;
  sqlState?: string;
  constraint?: string;
  message?: string;
  previous?: unknown;
  cause?: unknown;
}

function chain(err: unknown): PgLikeError[] {
  const out: PgLikeError[] = [];
  let current: unknown = err;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    out.push(current as PgLikeError);
    current = (current as PgLikeError).previous ?? (current as PgLikeError).cause;
  }
  return out;
}

export function sqlState(err: unknown): string | undefined {
  for (const e of chain(err)) {
    const code = e.sqlState ?? e.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

export function isLockTimeout(err: unknown): boolean {
  return sqlState(err) === '55P03';
}

/**
 * Traduz erros do driver/ORM para a linguagem da aplicação:
 * - unique_violation → UniqueConstraintRaceError (o use case relê e responde replay ou conflito);
 * - falhas temporárias → TransientInfrastructureError (HTTP 503 / retry na fila);
 * - o resto (incluindo violações de CHECK e triggers) sobe como está: é bug, não caminho de negócio.
 */
export function translatePersistenceError(err: unknown): unknown {
  if (err instanceof TransientInfrastructureError || err instanceof UniqueConstraintRaceError) {
    return err;
  }
  const state = sqlState(err);
  if (state === '23505') {
    const constraint = chain(err).find((e) => typeof e.constraint === 'string')?.constraint;
    const fromMessage = chain(err)
      .map((e) => e.message ?? '')
      .join(' ')
      .match(/unique constraint "([^"]+)"/)?.[1];
    return new UniqueConstraintRaceError(constraint ?? fromMessage ?? 'unknown');
  }
  if (state && (TRANSIENT_SQLSTATES.has(state) || state.startsWith('08'))) {
    return new TransientInfrastructureError(`database ${state}`, err);
  }
  const message = chain(err)
    .map((e) => `${e.code ?? ''} ${e.message ?? ''}`)
    .join(' ');
  if (TRANSIENT_NETWORK.test(message)) {
    return new TransientInfrastructureError('database unavailable', err);
  }
  return err;
}
