import { EntitySchema } from '@mikro-orm/core';

/**
 * Records de persistência mapeados com EntitySchema (sem decorators). O domínio nunca os vê:
 * a conversão record ↔ domínio fica em mappers.ts. Valores monetários são `decimal` mapeados como
 * string: o driver devolve NUMERIC como texto e ele vai direto para Money.rehydrate, sem `number`.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultingBalanceAmount?: string | null;
  resultingBalanceCurrency?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
  updatedAt!: Date;
}

export class LedgerEntryRecord {
  id!: string;
  sequence?: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedUntil?: Date | null;
  lastError?: string | null;
  publishedAt?: Date | null;
}

const money = { type: 'decimal', precision: 20, scale: 2 } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balanceAmount: { ...money },
    version: { type: 'integer' },
    createdAt: { ...timestamp },
    updatedAt: { ...timestamp },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { ...money },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultingBalanceAmount: { ...money, nullable: true },
    resultingBalanceCurrency: { type: 'string', length: 3, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { ...timestamp, nullable: true },
    createdAt: { ...timestamp },
    processedAt: { ...timestamp, nullable: true },
    updatedAt: { ...timestamp },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    // gerada pelo banco (identity), nunca escrita pela aplicação
    sequence: { type: 'bigint', persist: false, nullable: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { ...money },
    currency: { type: 'string', length: 3 },
    balanceBeforeAmount: { ...money },
    balanceAfterAmount: { ...money },
    walletVersion: { type: 'integer' },
    createdAt: { ...timestamp },
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: { ...timestamp },
    processedAt: { ...timestamp, nullable: true },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { ...timestamp },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp },
    lockedUntil: { ...timestamp, nullable: true },
    lastError: { type: 'text', nullable: true },
    publishedAt: { ...timestamp, nullable: true },
  },
});

export const persistenceSchemas = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
