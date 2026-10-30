import type { FailureCode } from './failure-code';

/** Base de todos os erros de domínio. Nunca carrega detalhes de infraestrutura. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada inválida em um contrato (Money mal formado, campo ausente...). Mapeada para 400. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`);
  }
}

/**
 * Violação de regra de negócio que deve virar uma transação REJECTED com failureCode estável.
 * Lançada pelo domínio e capturada pelo use case.
 */
export class BusinessRuleViolation extends DomainError {
  readonly code = 'BUSINESS_RULE_VIOLATION';

  constructor(
    readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** Tentativa de transicionar uma transação terminal: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

/** Uma invariante interna foi quebrada (ex.: lançamento desbalanceado). Erro de programação. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
