import { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { MoneyProps } from '../domain/money';
import { Money } from '../domain/money';
import { type FailureCode } from '../domain/failure-code';
import { WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  NotFoundError,
  UniqueConstraintRaceError,
} from './errors';
import { computePayloadHash, sha256Hex, type WagerPayloadSubset } from './payload-hash';
import type { Clock, IdGenerator, Metrics, TransactionScope, UnitOfWork } from './ports';
import { WagerSettlement } from './wager-settlement';

export interface SubmitWagerCommand extends WagerPayloadSubset {
  idempotencyKey: string;
}

export type SubmissionSource =
  | { type: 'http' }
  | { type: 'sqs'; messageId: string; consumerName: string; rawBody: string };

export interface SubmitWagerInput {
  command: SubmitWagerCommand;
  source: SubmissionSource;
  correlationId: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  balance: MoneyProps | undefined;
  idempotentReplay: boolean;
  /** true quando a mensagem SQS já tinha sido processada (inbox): nada foi feito, só ack. */
  duplicateMessage: boolean;
}

/**
 * Use case único de submissão, usado pela API HTTP e pelo consumidor SQS.
 *
 * Tudo acontece em UMA transação SQL, com a wallet travada (SELECT ... FOR UPDATE):
 * inbox → idempotência → regras → saldo + ledger → transação → outbox → commit.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(input: SubmitWagerInput): Promise<SubmitWagerResult> {
    const startedAt = performance.now();
    const payloadHash = computePayloadHash(input.command);
    let result: SubmitWagerResult;
    try {
      result = await this.uow.run((scope) => this.process(scope, input, payloadHash));
    } catch (err) {
      if (!(err instanceof UniqueConstraintRaceError)) {
        throw err;
      }
      // Outra instância confirmou a mesma chave entre a nossa leitura e a nossa escrita
      // (só acontece quando wallets diferentes disputam a mesma key, já que a mesma wallet é serializada
      // pelo lock). Uma nova tentativa enxerga o estado confirmado e responde como replay ou conflito.
      result = await this.uow.run((scope) => this.process(scope, input, payloadHash));
    }
    if (result.idempotentReplay) {
      this.metrics.idempotentReplay(input.source.type);
    } else if (!result.duplicateMessage) {
      this.metrics.transactionFinished(
        input.command.kind,
        result.status,
        input.source.type,
        (performance.now() - startedAt) / 1000,
      );
    }
    return result;
  }

  private async process(
    scope: TransactionScope,
    input: SubmitWagerInput,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const { command, source } = input;
    const now = this.clock.now();

    const wallet = await scope.lockWallet(command.walletId);
    if (!wallet) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${command.walletId} not found`);
    }

    let inbox: InboxMessage | undefined;
    if (source.type === 'sqs') {
      inbox = InboxMessage.receive({
        messageId: source.messageId,
        consumerName: source.consumerName,
        payloadHash: sha256Hex(source.rawBody),
        receivedAt: now,
      });
      const firstDelivery = await scope.tryInsertInbox(inbox);
      if (!firstDelivery) {
        this.metrics.duplicateMessage();
        const previous = await scope.findTransactionByIdempotencyKey(command.idempotencyKey);
        return previous ? { ...this.replay(previous), idempotentReplay: true, duplicateMessage: true } : this.noop();
      }
    }

    const existing = await scope.findTransactionByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        this.metrics.idempotencyConflict();
        throw new IdempotencyConflictError(command.idempotencyKey, existing.id);
      }
      if (inbox) {
        await scope.markInboxProcessed(inbox);
      }
      return { ...this.replay(existing), idempotentReplay: true, duplicateMessage: false };
    }
    const sameExternal = await scope.findTransactionByExternalId(command.providerId, command.externalTransactionId);
    if (sameExternal) {
      this.metrics.idempotencyConflict();
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const ctx = {
      scope,
      wallet,
      correlationId: input.correlationId,
      causationId: source.type === 'sqs' ? source.messageId : undefined,
    };
    const outcome = await this.settlement.settle(tx, ctx);

    // Ordem das escritas respeita as FKs; a consistência saldo ↔ ledger é verificada no commit.
    await scope.insertTransaction(tx);
    await this.persistMovement(scope, outcome.entry);
    const outbox = WagerSettlement.toOutbox(outcome);

    // Resolução antecipada: transações desta wallet que aguardavam por esta como referência.
    // O worker continua sendo a garantia; aqui só evitamos esperar o próximo ciclo.
    if (tx.status === WagerTransactionStatus.Processed) {
      const waiting = await scope.findPendingWaitingFor(wallet.id, tx.providerId, tx.externalTransactionId);
      for (const dependent of waiting) {
        const dependentOutcome = await this.settlement.settle(dependent, { ...ctx, causationId: tx.id });
        await scope.updateTransaction(dependent);
        await this.persistMovement(scope, dependentOutcome.entry);
        outbox.push(...WagerSettlement.toOutbox(dependentOutcome));
      }
    }

    await scope.enqueue(outbox);
    if (inbox) {
      inbox.markProcessed(now);
      await scope.markInboxProcessed(inbox);
    }

    return { ...this.replay(tx), idempotentReplay: false, duplicateMessage: false };
  }

  /** Cada lançamento corresponde a exatamente um UPDATE da wallet (version + 1), como o schema exige. */
  private async persistMovement(scope: TransactionScope, entry: WalletLedgerEntry | undefined): Promise<void> {
    if (!entry) {
      return;
    }
    await scope.insertLedgerEntry(entry);
    await scope.applyLedgerEntryToWallet(entry);
  }

  private replay(tx: WagerTransaction): Omit<SubmitWagerResult, 'idempotentReplay' | 'duplicateMessage'> {
    return {
      transactionId: tx.id,
      status: tx.status,
      failureCode: tx.failureCode,
      balance: tx.resultingBalance?.toJSON(),
    };
  }

  private noop(): SubmitWagerResult {
    return {
      transactionId: '',
      status: WagerTransactionStatus.Pending,
      failureCode: undefined,
      balance: undefined,
      idempotentReplay: true,
      duplicateMessage: true,
    };
  }
}
