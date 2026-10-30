import { InvalidTransactionStateError, InvariantViolationError, ValidationError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds que um provedor pode submeter (OPENING é interno). */
export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Que kinds cada reversão pode referenciar (README §7, regra 3). */
const REVERSIBLE_BY: Record<string, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

export const OPENING_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  resultingBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | undefined;
  updatedAt: Date;
}

/**
 * Transições válidas:
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ──► PENDING_REFERENCE (reagendamento) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED: terminais (qualquer transição lança InvalidTransactionStateError)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceAttempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. OPENING não é aceito aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new ValidationError('OPENING is an internal transaction kind and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** Transação interna de abertura de wallet. Usada somente por CreateWallet. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    const tx = WagerTransaction.build({
      ...props,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${OPENING_PROVIDER_ID}:opening:${props.walletId}`,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      referenceExternalTransactionId: undefined,
    });
    tx.markProcessed(undefined, props.createdAt, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.updatedAt,
      state.referenceAttempts,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  /** Saldo observado no momento em que a transação chegou ao estado atual (usado no replay). */
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultingBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvariantViolationError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  /**
   * Entra (ou permanece) em PENDING_REFERENCE e agenda a próxima verificação.
   * Cada chamada a partir de PENDING_REFERENCE conta uma tentativa.
   */
  markPendingReference(nextCheckAt: Date, at: Date, observedBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceCheckAt = nextCheckAt;
    this._resultingBalance = observedBalance;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK inverte a direção da referência.
   * @throws InvariantViolationError para LOSS (sem efeito no saldo) ou ROLLBACK sem referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK requires the referenced transaction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not affect the balance');
    }
  }

  /**
   * Valida a referência já resolvida (README §7, regras 2 a 5).
   * Devolve o failureCode da rejeição, ou `undefined` quando a referência é aceitável.
   * Não decide sobre "já revertida": isso depende de consulta ao repositório (e do índice único no banco).
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    const allowed = REVERSIBLE_BY[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return FailureCode.ReferenceInvalidKind;
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.money.currency !== this.money.currency) {
      return FailureCode.CurrencyMismatch;
    }
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    return undefined;
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const isReversal = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (isReversal && !props.referenceExternalTransactionId) {
      throw new ValidationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new ValidationError(`${props.kind} amount must be greater than zero`);
    }
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'roundId', 'gameId'] as const) {
      if (!props[field] || props[field].trim() === '') {
        throw new ValidationError(`${field} is required`);
      }
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      props.createdAt,
      0,
    );
  }
}
