import { FailureCode } from '../domain/failure-code';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/integration-events';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/outbox-message';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { Clock, IdGenerator, TransactionScope } from './ports';

export interface ReferenceRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface SettlementContext {
  scope: TransactionScope;
  wallet: Wallet;
  correlationId: string;
  causationId?: string | undefined;
}

export interface SettlementOutcome {
  entry: WalletLedgerEntry | undefined;
  events: IntegrationEvent<unknown>[];
}

/**
 * Aplica as regras de negócio (README §7) a uma transação ainda não terminal, com a wallet já travada.
 * Não grava nada: devolve o lançamento e os eventos para quem chamou persistir na mesma transação SQL.
 *
 * É compartilhado pela submissão (HTTP e SQS) e pelo worker de PENDING_REFERENCE, garantindo que
 * as duas entradas apliquem exatamente as mesmas regras.
 */
export class WagerSettlement {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async settle(tx: WagerTransaction, ctx: SettlementContext): Promise<SettlementOutcome> {
    const { wallet, scope } = ctx;
    const now = this.clock.now();

    if (tx.playerId !== wallet.playerId) {
      return this.rejected(tx, FailureCode.WalletPlayerMismatch, ctx);
    }
    if (tx.money.currency !== wallet.currency) {
      return this.rejected(tx, FailureCode.CurrencyMismatch, ctx);
    }

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      reference = await scope.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const missing =
        !reference ||
        reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference;
      if (missing) {
        return this.waitForReference(tx, ctx, now);
      }
      if (reference!.status !== WagerTransactionStatus.Processed) {
        return this.rejected(tx, FailureCode.ReferenceNotProcessed, ctx);
      }
      const referenceProblem = tx.checkReference(reference!);
      if (referenceProblem) {
        return this.rejected(tx, referenceProblem, ctx);
      }
      if (tx.isReversal() && (await scope.hasProcessedReversal(reference!.id))) {
        return this.rejected(tx, FailureCode.ReferenceAlreadyReversed, ctx);
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { entry: undefined, events: [WagerTransactionProcessed.from(tx, this.eventContext(ctx, now))] };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, now };
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // Aposta sem saldo e reversão sem saldo são situações operacionalmente diferentes (§7, regra 9).
      const code =
        tx.kind === WagerTransactionKind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return this.rejected(tx, code, ctx);
    }
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, now, wallet.balance);

    return {
      entry,
      events: [
        WagerTransactionProcessed.from(tx, this.eventContext(ctx, now)),
        WalletBalanceChanged.from(wallet, entry, this.eventContext(ctx, now)),
      ],
    };
  }

  /** Esgotou as tentativas de encontrar a referência: rejeição terminal e auditável. */
  expire(tx: WagerTransaction, ctx: SettlementContext): SettlementOutcome {
    return this.rejected(tx, FailureCode.ReferenceNotFound, ctx);
  }

  /** Converte o resultado em mensagens de outbox (o id da mensagem é o eventId). */
  static toOutbox(outcome: SettlementOutcome): OutboxMessage[] {
    return outcome.events.map((event) => OutboxMessage.enqueue(event));
  }

  private waitForReference(tx: WagerTransaction, ctx: SettlementContext, now: Date): SettlementOutcome {
    const firstTime = tx.status === WagerTransactionStatus.Pending;
    const nextAttempt = firstTime ? 0 : tx.referenceAttempts + 1;
    if (nextAttempt >= this.retryPolicy.maxAttempts) {
      return this.expire(tx, ctx);
    }
    tx.markPendingReference(new Date(now.getTime() + this.delayFor(nextAttempt)), now, ctx.wallet.balance);
    // O evento só é emitido na primeira vez: reagendamentos não são fatos novos para o consumidor.
    const events = firstTime ? [WagerTransactionPendingReference.from(tx, this.eventContext(ctx, now))] : [];
    return { entry: undefined, events };
  }

  private rejected(tx: WagerTransaction, code: FailureCode, ctx: SettlementContext): SettlementOutcome {
    const now = this.clock.now();
    tx.reject(code, now, ctx.wallet.balance);
    return { entry: undefined, events: [WagerTransactionRejected.from(tx, this.eventContext(ctx, now))] };
  }

  /** Backoff exponencial com jitter de ±20%, limitado a maxDelayMs. */
  private delayFor(attempt: number): number {
    const raw = Math.min(this.retryPolicy.baseDelayMs * 2 ** attempt, this.retryPolicy.maxDelayMs);
    const jitter = raw * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(raw + jitter));
  }

  private eventContext(ctx: SettlementContext, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: now,
    };
  }
}
