import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação propagados automaticamente para todos os logs da mesma requisição/mensagem. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Enriquece o contexto corrente (ex.: depois que o transactionId é conhecido). */
export function enrichContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, fields);
  }
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}
