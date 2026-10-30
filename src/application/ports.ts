import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const READ_MODEL = Symbol('ReadModel');
export const OUTBOX_STORE = Symbol('OutboxStore');
export const EVENT_PUBLISHER = Symbol('EventPublisher');
export const METRICS = Symbol('Metrics');

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUIDv7: ordenável no tempo. */
  next(): string;
}

/**
 * Operações disponíveis dentro de UMA transação SQL. Tudo que um use case grava passa por aqui,
 * então inbox, transação, ledger, saldo e outbox são confirmados juntos ou nenhum é.
 */
export interface TransactionScope {
  /** SELECT ... FOR UPDATE na linha da wallet: serializa as operações daquela wallet, e só dela. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  /**
   * Grava o saldo produzido por um lançamento: UPDATE condicionado à versão anterior
   * (`version = entry.walletVersion - 1`), defesa extra além do row lock.
   * @throws Error se nenhuma linha foi afetada.
   */
  applyLedgerEntryToWallet(entry: WalletLedgerEntry): Promise<void>;

  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Lê a transação travando a linha (usado pelo worker de referências, já sob o lock da wallet). */
  findTransactionForUpdate(transactionId: string): Promise<WagerTransaction | undefined>;
  /** Pendentes desta wallet aguardando a referência (providerId, externalTransactionId). */
  findPendingWaitingFor(walletId: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  updateTransaction(tx: WagerTransaction): Promise<void>;

  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;

  /** INSERT ... ON CONFLICT DO NOTHING. `false` significa redelivery: a mensagem já foi vista. */
  tryInsertInbox(message: InboxMessage): Promise<boolean>;
  markInboxProcessed(message: InboxMessage): Promise<void>;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
  walletVersion: number;
  lastEntryVersion: number | undefined;
  lastEntryBalanceAfter: Money | undefined;
}

export interface ReadModel {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  findTransaction(transactionId: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Paginação por wallet_version decrescente (cursor estável e opaco). */
  ledgerPage(walletId: string, limit: number, beforeVersion: number | undefined): Promise<LedgerPage>;
  /** Saldo materializado e saldo do ledger lidos no mesmo snapshot (uma única instrução SQL). */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ClaimedTransaction {
  id: string;
  walletId: string;
}

export interface OutboxStore {
  /** Reserva (lease) um lote de mensagens devidas com FOR UPDATE SKIP LOCKED em transação curta. */
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(ids: readonly string[], at: Date): Promise<void>;
  scheduleRetry(message: OutboxMessage, error: string): Promise<void>;
  /** Idade em segundos da mensagem pendente mais antiga, e quantas estão pendentes. */
  lag(now: Date): Promise<{ oldestAgeSeconds: number; pending: number }>;
  /** Reserva transações PENDING_REFERENCE devidas, com SKIP LOCKED, empurrando o próximo check pelo lease. */
  claimDuePendingReferences(limit: number, leaseMs: number): Promise<ClaimedTransaction[]>;
}

export interface EventPublisher {
  /** Publica no broker. Deve ser idempotente do ponto de vista do consumidor (dedup por eventId). */
  publish(messages: readonly OutboxMessage[]): Promise<{ published: string[]; failed: { id: string; error: string }[] }>;
}

/** Métricas de negócio, implementadas com prom-client. A aplicação não conhece a lib. */
export interface Metrics {
  transactionFinished(kind: string, status: string, source: string, durationSeconds: number): void;
  idempotentReplay(source: string): void;
  duplicateMessage(): void;
  idempotencyConflict(): void;
  lockConflict(): void;
  sqsRetry(): void;
  sqsDeadLettered(reason: string): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(count: number): void;
  outboxLag(oldestAgeSeconds: number, pending: number): void;
  pendingReferenceRetry(): void;
  pendingReferenceExpired(): void;
  reconciliationDivergence(): void;
}
