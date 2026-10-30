import { isFailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './schemas';

/** NUMERIC chega como string; normaliza para 2 casas sem nunca passar por `number`. */
export function amountToString(value: string | number): string {
  if (typeof value === 'number') {
    throw new Error('Monetary column was read as number; refusing to continue');
  }
  const [units = '0', cents = ''] = value.split('.');
  return `${units}.${cents.padEnd(2, '0').slice(0, 2)}`;
}

function money(amount: string, currency: string): Money {
  return Money.rehydrate(amountToString(amount), currency.trim());
}

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency.trim(),
      balance: money(r.balanceAmount, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balanceAmount: w.balance.toString(),
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const TransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const failureCode = r.failureCode ?? undefined;
    if (failureCode !== undefined && !isFailureCode(failureCode)) {
      throw new Error(`Unknown failure code ${failureCode} in transaction ${r.id}`);
    }
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash.trim(),
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode,
      processedAt: r.processedAt ?? undefined,
      resultingBalance:
        r.resultingBalanceAmount === null ||
        r.resultingBalanceAmount === undefined ||
        r.resultingBalanceCurrency === null ||
        r.resultingBalanceCurrency === undefined
          ? undefined
          : money(r.resultingBalanceAmount, r.resultingBalanceCurrency),
      referenceAttempts: r.referenceAttempts,
      nextReferenceCheckAt: r.nextReferenceCheckAt ?? undefined,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.toString(),
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      // saldo observado está na moeda da wallet, que pode diferir da moeda da transação (CURRENCY_MISMATCH)
      resultingBalanceAmount: t.resultingBalance?.toString() ?? null,
      resultingBalanceCurrency: t.resultingBalance?.currency ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceCheckAt: t.nextReferenceCheckAt ?? null,
      createdAt: t.createdAt,
      processedAt: t.processedAt ?? null,
      updatedAt: t.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBeforeAmount, r.currency),
      balanceAfter: money(r.balanceAfterAmount, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): Omit<LedgerEntryRecord, 'sequence'> {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toString(),
      currency: e.money.currency,
      balanceBeforeAmount: e.balanceBefore.toString(),
      balanceAfterAmount: e.balanceAfter.toString(),
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const InboxMapper = {
  toDomain(r: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: r.messageId,
      consumerName: r.consumerName,
      payloadHash: r.payloadHash.trim(),
      receivedAt: r.receivedAt,
      processedAt: r.processedAt ?? undefined,
    });
  },
};

export const OutboxMapper = {
  toDomain(r: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      publishedAt: r.publishedAt ?? undefined,
    });
  },
  toRecord(m: OutboxMessage): OutboxRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      // cópia profunda: o envelope do domínio é congelado e o ORM normaliza parâmetros in-place
      payload: JSON.parse(JSON.stringify(m.payload)) as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      lockedUntil: null,
      lastError: null,
      publishedAt: m.publishedAt ?? null,
    };
  },
};
