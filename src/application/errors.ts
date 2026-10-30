/**
 * Erros da camada de aplicação. Cada um tem semântica operacional distinta e é mapeado de forma
 * consistente para HTTP (filtro de exceções) e para SQS (ack, retry ou DLQ).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Mesma idempotency key (ou mesmo external id) com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(
    readonly idempotencyKey: string,
    readonly existingTransactionId: string,
  ) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(`Transaction ${providerId}/${externalTransactionId} already exists under a different idempotency key`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} in ${currency} already exists`);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

/** Token válido, mas de outro provedor. */
export class ProviderMismatchError extends ApplicationError {
  readonly code = 'PROVIDER_MISMATCH';

  constructor(tokenProvider: string, requestedProvider: string) {
    super(`Credentials for ${tokenProvider} cannot act on behalf of ${requestedProvider}`);
  }
}

/**
 * Falha temporária de infraestrutura (banco indisponível, lock timeout, serialização, SQS fora).
 * Seguro reenviar: nada foi confirmado.
 */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(`Transient infrastructure failure: ${reason}`);
  }
}

/**
 * Uma constraint de unicidade disparou durante a escrita (corrida entre duas instâncias com a mesma
 * chave). O use case relê o estado confirmado e responde como replay ou conflito.
 */
export class UniqueConstraintRaceError extends ApplicationError {
  readonly code = 'UNIQUE_CONSTRAINT_RACE';

  constructor(readonly constraint: string) {
    super(`Unique constraint ${constraint} raced with a concurrent writer`);
  }
}
