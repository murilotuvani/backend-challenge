import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork } from '../../application/ports';
import type { Metrics } from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerEntryMapper, OutboxMapper, TransactionMapper, WalletMapper } from './mappers';
import { isLockTimeout, translatePersistenceError } from './pg-errors';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  type WagerTransactionRecord,
  WagerTransactionSchema,
  WalletSchema,
} from './schemas';

/**
 * Implementação do TransactionScope sobre um EntityManager já dentro de `em.transactional()`.
 *
 * Leituras usam o EntityManager (com identity map). Escritas usam inserts/updates nativos em ordem
 * explícita: a ordem respeita as FKs e cada UPDATE da wallet corresponde a exatamente um lançamento,
 * que é o que o constraint trigger do banco verifica no commit.
 */
class MikroOrmTransactionScope implements TransactionScope {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
  }

  async applyLedgerEntryToWallet(entry: WalletLedgerEntry): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: entry.walletId, version: entry.walletVersion - 1 },
      { balanceAmount: entry.balanceAfter.toString(), version: entry.walletVersion, updatedAt: entry.createdAt },
    );
    if (affected !== 1) {
      // Impossível com o row lock; se acontecer, é bug e a transação inteira é desfeita.
      throw new Error(`Wallet ${entry.walletId} changed concurrently (expected version ${entry.walletVersion - 1})`);
    }
  }

  async findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOneTx({ idempotencyKey });
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string) {
    return this.findOneTx({ providerId, externalTransactionId });
  }

  async findTransactionForUpdate(transactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { id: transactionId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? TransactionMapper.toDomain(record) : undefined;
  }

  async findPendingWaitingFor(walletId: string, providerId: string, externalTransactionId: string) {
    const records = await this.em.find(
      WagerTransactionSchema,
      { walletId, providerId, referenceExternalTransactionId: externalTransactionId, status: 'PENDING_REFERENCE' },
      { orderBy: { createdAt: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return records.map((r) => TransactionMapper.toDomain(r));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return count > 0;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, TransactionMapper.toRecord(tx));
  }

  async updateTransaction(tx: WagerTransaction): Promise<void> {
    const r = TransactionMapper.toRecord(tx);
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        processedAt: r.processedAt,
        resultingBalanceAmount: r.resultingBalanceAmount,
        resultingBalanceCurrency: r.resultingBalanceCurrency,
        referenceAttempts: r.referenceAttempts,
        nextReferenceCheckAt: r.nextReferenceCheckAt,
        updatedAt: r.updatedAt,
      },
    );
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(OutboxSchema, messages.map((m) => OutboxMapper.toRecord(m)));
    }
  }

  async tryInsertInbox(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async markInboxProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? new Date() },
    );
  }

  private async findOneTx(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, { refresh: true });
    return record ? TransactionMapper.toDomain(record) : undefined;
  }
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    // Um EntityManager novo por unidade de trabalho: identity map isolado, nada vaza entre requisições.
    const em = this.orm.em.fork();
    try {
      return await em.transactional((txEm) => work(new MikroOrmTransactionScope(txEm)));
    } catch (err) {
      if (isLockTimeout(err)) {
        this.metrics?.lockConflict();
      }
      throw translatePersistenceError(err);
    }
  }
}
