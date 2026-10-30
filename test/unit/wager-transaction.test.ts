import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-10-30T12:00:00Z');

function tx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'h1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: Kind.Bet,
    money: brl('10.00'),
    createdAt: now,
    ...overrides,
  });
}

describe('WagerTransaction', () => {
  test('nasce em PENDING', () => {
    expect(tx().status).toBe(Status.Pending);
  });

  test('OPENING não pode ser submetido externamente', () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(ValidationError);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => tx({ kind: Kind.Refund })).toThrow(ValidationError);
    expect(() => tx({ kind: Kind.Rollback })).toThrow(ValidationError);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }).requiresReference()).toBe(true);
  });

  test('valor deve ser positivo, exceto LOSS que aceita zero', () => {
    expect(() => tx({ money: brl('0.00') })).toThrow(ValidationError);
    expect(tx({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test('estados terminais não aceitam transições', () => {
    const processed = tx();
    processed.markProcessed(undefined, now, brl('90.00'));
    expect(processed.isTerminal()).toBe(true);
    expect(() => processed.reject(FailureCode.InsufficientFunds, now, undefined)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => processed.markProcessed(undefined, now, brl('1.00'))).toThrow(InvalidTransactionStateError);

    const rejected = tx();
    rejected.reject(FailureCode.InsufficientFunds, now, brl('5.00'));
    expect(() => rejected.markPendingReference(now, now, brl('5.00'))).toThrow(InvalidTransactionStateError);

    const failed = tx();
    failed.fail(FailureCode.InfraPermanentFailure, now);
    expect(() => failed.markProcessed(undefined, now, brl('5.00'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE pode ser reagendado e conta tentativas', () => {
    const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' });
    refund.markPendingReference(new Date(now.getTime() + 1000), now, brl('1.00'));
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(0);
    refund.markPendingReference(new Date(now.getTime() + 2000), now, brl('1.00'));
    expect(refund.referenceAttempts).toBe(1);
    refund.reject(FailureCode.ReferenceNotFound, now, brl('1.00'));
    expect(refund.isTerminal()).toBe(true);
  });

  test('reversão não pode ser processada sem referência resolvida', () => {
    const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' });
    expect(() => refund.markProcessed(undefined, now, brl('1.00'))).toThrow();
  });

  test('direção do ledger por kind; ROLLBACK inverte a referência', () => {
    const bet = tx();
    const win = tx({ id: 'tx-2', kind: Kind.Win });
    const refund = tx({ id: 'tx-3', kind: Kind.Refund, referenceExternalTransactionId: 'ext-1' });
    const rollback = tx({ id: 'tx-4', kind: Kind.Rollback, referenceExternalTransactionId: 'ext-1' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow();
  });

  test('matchesPayload compara o hash', () => {
    expect(tx().matchesPayload('h1')).toBe(true);
    expect(tx().matchesPayload('h2')).toBe(false);
  });
});

describe('Regras de referência', () => {
  const bet = tx();
  const reversal = (kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}) =>
    tx({ id: 'tx-r', externalTransactionId: 'ext-r', kind, referenceExternalTransactionId: 'ext-1', ...overrides });

  test('REFUND só referencia BET', () => {
    expect(reversal(Kind.Refund).checkReference(bet)).toBeUndefined();
    const win = tx({ id: 'tx-w', kind: Kind.Win });
    expect(reversal(Kind.Refund).checkReference(win)).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('ROLLBACK referencia BET, WIN ou REFUND, mas não ROLLBACK', () => {
    const win = tx({ id: 'tx-w', kind: Kind.Win });
    const refund = tx({ id: 'tx-f', kind: Kind.Refund, referenceExternalTransactionId: 'x' });
    const rollback = tx({ id: 'tx-b', kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(reversal(Kind.Rollback).checkReference(bet)).toBeUndefined();
    expect(reversal(Kind.Rollback).checkReference(win)).toBeUndefined();
    expect(reversal(Kind.Rollback).checkReference(refund)).toBeUndefined();
    expect(reversal(Kind.Rollback).checkReference(rollback)).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('referência deve ser do mesmo provider, player, wallet e rodada', () => {
    expect(reversal(Kind.Refund, { roundId: 'r2' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    expect(reversal(Kind.Refund, { playerId: 'p2' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    expect(reversal(Kind.Refund, { walletId: 'w2' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    expect(reversal(Kind.Refund, { providerId: 'provider-b' }).checkReference(bet)).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  test('referência em outra moeda é conflito de moeda', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(reversal(Kind.Refund, { money: usd }).checkReference(bet)).toBe(FailureCode.CurrencyMismatch);
  });

  test('reversão deve ter o mesmo valor da referência', () => {
    expect(reversal(Kind.Refund, { money: brl('9.99') }).checkReference(bet)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
  });

  test('WIN pode referenciar BET com valor diferente', () => {
    expect(tx({ id: 'tx-w', kind: Kind.Win, money: brl('50.00') }).checkReference(bet)).toBeUndefined();
  });
});
