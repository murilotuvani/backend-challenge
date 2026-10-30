import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-10-30T12:00:00Z');

function open(initial: string) {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(initial),
    openingTransactionId: 't0',
    openingEntryId: 'e0',
    now,
  });
}

describe('Wallet', () => {
  test('abre com version 1 e lançamento de abertura quando o saldo inicial é positivo', () => {
    const { wallet, openingEntry } = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('débito e crédito produzem lançamento consistente e incrementam version', () => {
    const { wallet } = open('100.00');
    const debit = wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('80.00'), now });
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('20.00');
    expect(debit.walletVersion).toBe(2);
    expect(debit.isBalanced()).toBe(true);

    const credit = wallet.credit({ entryId: 'e2', transactionId: 't2', money: brl('5.50'), now });
    expect(wallet.balance.toString()).toBe('25.50');
    expect(wallet.version).toBe(3);
    expect(credit.walletVersion).toBe(3);
  });

  test('saldo nunca fica negativo e falha não altera o agregado', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('100.01'), now })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('débito do saldo exato zera a wallet', () => {
    const { wallet } = open('80.00');
    wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('80.00'), now });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('moeda da operação deve ser igual à da wallet', () => {
    const { wallet } = open('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit({ entryId: 'e1', transactionId: 't1', money: usd, now })).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.debit({ entryId: 'e1', transactionId: 't1', money: usd, now })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('42.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    walletVersion: 2,
    createdAt: now,
  };

  test('valida a aritmética na factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('95.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('rejeita valor zero e saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: Money.rehydrate('-1.00', 'BRL'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('1.00'),
      balanceAfter: brl('2.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow();
  });
});
