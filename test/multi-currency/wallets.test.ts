import { afterAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { call, getWallet, reconcile, submit } from '../support/api';
import { assertLedgerConsistency, createPool } from '../support/db';
import { env } from '../support/env';

/**
 * Caixa-preta, contra as 3 instâncias: um jogador com quatro wallets (BRL, USD, EUR, CHF).
 * Cobre a unicidade (jogador, moeda), o isolamento entre as wallets e a rejeição CURRENCY_MISMATCH
 * quando a transação chega numa moeda diferente da wallet.
 */

const CURRENCIES = ['BRL', 'USD', 'EUR', 'CHF'] as const;
type Currency = (typeof CURRENCIES)[number];
interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

const pool: pg.Pool = createPool(env.appDbName);

afterAll(async () => {
  await assertLedgerConsistency(pool);
  await pool.end();
});

const createFor = (playerId: string, currency: string, amount = '100.00', instance?: number) =>
  call('POST', '/wallets', { as: 'back-office', body: { playerId, initialBalance: { amount, currency } }, instance });

async function openFourWallets(): Promise<{ playerId: string; wallets: Record<Currency, WalletView> }> {
  const playerId = crypto.randomUUID();
  const responses = await Promise.all(CURRENCIES.map((c, i) => createFor(playerId, c, '100.00', i)));
  for (const r of responses) {
    expect(r.status).toBe(201);
  }
  const wallets = Object.fromEntries(CURRENCIES.map((c, i) => [c, responses[i]!.body as WalletView])) as Record<Currency, WalletView>;
  return { playerId, wallets };
}

describe('um jogador com quatro wallets (BRL, USD, EUR, CHF)', () => {
  test('cria as quatro wallets, uma por moeda, todas do mesmo jogador', async () => {
    const { playerId, wallets } = await openFourWallets();

    expect(new Set(CURRENCIES.map((c) => wallets[c].id)).size).toBe(4);
    for (const c of CURRENCIES) {
      expect(wallets[c].playerId).toBe(playerId);
      expect(wallets[c].balance).toEqual({ amount: '100.00', currency: c });
      expect(wallets[c].version).toBe(1);
    }
    const { rows } = await pool.query(`select currency from wallets where player_id = $1 order by currency`, [playerId]);
    expect(rows.map((r) => r.currency.trim())).toEqual(['BRL', 'CHF', 'EUR', 'USD']);
  });

  test('uma segunda wallet na mesma moeda é recusada com 409 WALLET_ALREADY_EXISTS', async () => {
    const { playerId } = await openFourWallets();
    for (const c of CURRENCIES) {
      const dup = await createFor(playerId, c);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('WALLET_ALREADY_EXISTS');
    }
    const { rows } = await pool.query(`select count(*)::int as n from wallets where player_id = $1`, [playerId]);
    expect(rows[0].n).toBe(4);
  });

  test('criação simultânea da mesma moeda nas 3 instâncias → uma 201, as demais 409', async () => {
    const playerId = crypto.randomUUID();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => createFor(playerId, 'EUR', '50.00', i)));
    expect(responses.filter((r) => r.status === 201).length).toBe(1);
    expect(responses.filter((r) => r.status === 409).every((r) => r.body.code === 'WALLET_ALREADY_EXISTS')).toBe(true);
    expect(responses.filter((r) => r.status === 409).length).toBe(11);
  });

  test('apostas em paralelo nas quatro wallets não interferem entre si', async () => {
    const { playerId, wallets } = await openFourWallets();
    const amounts: Record<Currency, string> = { BRL: '10.00', USD: '20.00', EUR: '30.00', CHF: '40.00' };

    const responses = await Promise.all(
      CURRENCIES.flatMap((c) =>
        Array.from({ length: 2 }, (_, i) =>
          submit({ walletId: wallets[c].id, playerId, kind: 'BET', amount: amounts[c], currency: c }, { instance: i }),
        ),
      ),
    );
    expect(responses.every((r) => r.status === 201 && r.body.status === 'PROCESSED')).toBe(true);

    const expected: Record<Currency, string> = { BRL: '80.00', USD: '60.00', EUR: '40.00', CHF: '20.00' };
    for (const c of CURRENCIES) {
      const w = await getWallet(wallets[c].id);
      expect(w.balance.amount).toBe(expected[c]);
      expect(w.version).toBe(3);
      expect((await reconcile(wallets[c].id)).consistent).toBe(true);
    }
  });

  test('CurrencyMismatch: transação em moeda diferente da wallet → 422 CURRENCY_MISMATCH, saldo intacto', async () => {
    const { playerId, wallets } = await openFourWallets();
    const pairs = CURRENCIES.flatMap((walletCurrency) =>
      CURRENCIES.filter((c) => c !== walletCurrency).map((sent) => ({ walletCurrency, sent })),
    );
    expect(pairs.length).toBe(12);

    const responses = await Promise.all(
      pairs.map(({ walletCurrency, sent }, i) =>
        submit({ walletId: wallets[walletCurrency].id, playerId, kind: 'BET', amount: '5.00', currency: sent }, { instance: i }),
      ),
    );
    for (const r of responses) {
      expect(r.status).toBe(422);
      expect(r.body.status).toBe('REJECTED');
      expect(r.body.failureCode).toBe('CURRENCY_MISMATCH');
    }

    // a rejeição é registrada (idempotente), mas nenhum lançamento é criado e nenhum saldo muda
    for (const c of CURRENCIES) {
      const w = await getWallet(wallets[c].id);
      expect(w.balance.amount).toBe('100.00');
      expect(w.version).toBe(1);
    }
    const ids = CURRENCIES.map((c) => wallets[c].id);
    const entries = await pool.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = any($1)`, [ids]);
    expect(entries.rows[0].n).toBe(4); // só os lançamentos de abertura
    const rejected = await pool.query(
      `select count(*)::int as n from wager_transactions where wallet_id = any($1) and status = 'REJECTED' and failure_code = 'CURRENCY_MISMATCH'`,
      [ids],
    );
    expect(rejected.rows[0].n).toBe(12);
  });

  test('CurrencyMismatch: o replay da mesma requisição devolve a mesma rejeição, sem nova transação', async () => {
    const { playerId, wallets } = await openFourWallets();
    const bet = { walletId: wallets.USD.id, playerId, kind: 'BET', amount: '5.00', currency: 'EUR', externalTransactionId: `mismatch-${wallets.USD.id}` };

    const first = await submit(bet, { instance: 0 });
    const replays = await Promise.all([1, 2, 3].map((i) => submit(bet, { instance: i })));
    expect(first.status).toBe(422);
    expect(first.body.failureCode).toBe('CURRENCY_MISMATCH');
    for (const r of replays) {
      expect(r.status).toBe(422);
      expect(r.body.transactionId).toBe(first.body.transactionId);
      expect(r.body.failureCode).toBe('CURRENCY_MISMATCH');
      expect(r.body.idempotentReplay).toBe(true);
    }
    expect((await getWallet(wallets.USD.id)).balance.amount).toBe('100.00');
  });
});
