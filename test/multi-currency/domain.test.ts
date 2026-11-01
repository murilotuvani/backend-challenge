import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

/**
 * Um jogador com quatro wallets (BRL, USD, EUR, CHF): o domínio nunca mistura moedas.
 * Qualquer movimento numa moeda diferente da wallet lança CurrencyMismatchError sem alterar o estado.
 */

const CURRENCIES = ['BRL', 'USD', 'EUR', 'CHF'] as const;
const now = new Date('2026-10-30T12:00:00Z');
const money = (amount: string, currency: string) => Money.from({ amount, currency });

function openWallets() {
  return CURRENCIES.map((currency) =>
    Wallet.open({
      id: `w-${currency}`,
      playerId: 'player-1',
      initialBalance: money('100.00', currency),
      openingTransactionId: `t0-${currency}`,
      openingEntryId: `e0-${currency}`,
      now,
    }).wallet,
  );
}

const otherPairs = CURRENCIES.flatMap((walletCurrency) =>
  CURRENCIES.filter((c) => c !== walletCurrency).map((received) => [walletCurrency, received] as const),
);

describe('um jogador, quatro moedas: CurrencyMismatchError no domínio', () => {
  test('as quatro wallets pertencem ao mesmo jogador e cada uma tem a sua moeda', () => {
    const wallets = openWallets();
    expect(wallets.map((w) => w.currency)).toEqual([...CURRENCIES]);
    expect(new Set(wallets.map((w) => w.playerId))).toEqual(new Set(['player-1']));
    for (const w of wallets) {
      expect(w.balance.toJSON()).toEqual({ amount: '100.00', currency: w.currency });
    }
  });

  test.each(otherPairs)('wallet %s: debit, credit e canDebit em %s lançam CurrencyMismatchError', (walletCurrency, received) => {
    const wallet = openWallets().find((w) => w.currency === walletCurrency)!;
    const movement = { entryId: 'e1', transactionId: 't1', money: money('10.00', received), now };

    expect(() => wallet.debit(movement)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(movement.money)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(movement)).toThrow(`Currency mismatch: expected ${walletCurrency}, received ${received}`);

    // nada mudou: o erro acontece antes de qualquer alteração de saldo ou versão
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: walletCurrency });
    expect(wallet.version).toBe(1);
  });

  test('o erro carrega o código CURRENCY_MISMATCH', () => {
    const usd = openWallets().find((w) => w.currency === 'USD')!;
    try {
      usd.credit({ entryId: 'e1', transactionId: 't1', money: money('1.00', 'CHF'), now });
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(CurrencyMismatchError);
      expect((err as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    }
  });

  test('Money não soma nem subtrai valores de moedas diferentes', () => {
    expect(() => money('1.00', 'USD').add(money('1.00', 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => money('1.00', 'EUR').subtract(money('1.00', 'CHF'))).toThrow(CurrencyMismatchError);
    expect(() => money('1.00', 'CHF').add(money('1.00', 'BRL'))).toThrow(CurrencyMismatchError);
  });

  test('movimentos na moeda certa continuam funcionando em cada wallet, de forma independente', () => {
    const wallets = openWallets();
    wallets.forEach((w, i) => {
      w.debit({ entryId: `e-${i}`, transactionId: `t-${i}`, money: money(`${i + 1}0.00`, w.currency), now });
    });
    expect(wallets.map((w) => w.balance.toString())).toEqual(['90.00', '80.00', '70.00', '60.00']);
    expect(wallets.every((w) => w.version === 2)).toBe(true);
  });
});
