import { sqlState } from '../persistence/pg-errors';

/**
 * Resumo de erro seguro para log. Erros do ORM trazem a query completa (com valores monetários e ids)
 * na mensagem: aqui guardamos só o tipo, o SQLSTATE e o motivo do banco, nunca os parâmetros.
 */
export function safeError(err: unknown): { type: string; sqlState?: string; reason: string } {
  if (!(err instanceof Error)) {
    return { type: typeof err, reason: String(err).slice(0, 200) };
  }
  const state = sqlState(err);
  const message = err.message ?? '';
  // MikroORM: "<sql> - <motivo do postgres>"
  const reason = message.includes(' - ') ? message.slice(message.lastIndexOf(' - ') + 3) : message;
  return {
    type: err.constructor?.name ?? err.name,
    ...(state ? { sqlState: state } : {}),
    reason: reason.slice(0, 300),
  };
}
