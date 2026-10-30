import { afterAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { createWallet, getWallet, reconcile, submit } from '../support/api';
import { assertLedgerConsistency, createPool } from '../support/db';
import { env } from '../support/env';

/**
 * Concorrência caixa-preta: requisições realmente paralelas distribuídas entre as 3 instâncias da
 * aplicação (app-1, app-2, app-3), contra o mesmo PostgreSQL. Nada é mockado.
 */

const pool: pg.Pool = createPool(env.appDbName);

afterAll(async () => {
  // invariante final: wallet.balance == saldo reconstruído pelo ledger, para TODAS as wallets
  await assertLedgerConsistency(pool);
  await pool.end();
});

const debits = async (walletId: string) =>
  (await pool.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).rows[0].n;

describe('concorrência', () => {
  test('1. a mesma aposta 50 vezes em paralelo → um único débito', async () => {
    const w = await createWallet('100.00');
    const bet = { walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '25.00', externalTransactionId: `same-${w.id}` };
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(bet, { instance: i })));

    const created = responses.filter((r) => r.status === 201);
    const replays = responses.filter((r) => r.status === 200);
    expect(created.length).toBe(1);
    expect(replays.length).toBe(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(replays.every((r) => r.body.idempotentReplay === true && r.body.balance.amount === '75.00')).toBe(true);
    expect(new Set(responses.map((r) => r.instance)).size).toBe(3);
    expect((await getWallet(w.id)).balance.amount).toBe('75.00');
    expect(await debits(w.id)).toBe(1);
  });

  test('2. saldo 100.00, duas apostas de 80.00 simultâneas → uma PROCESSED, outra REJECTED', async () => {
    for (let round = 0; round < 5; round += 1) {
      const w = await createWallet('100.00');
      const [a, b] = await Promise.all([
        submit({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '80.00' }, { instance: 0 }),
        submit({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '80.00' }, { instance: 1 }),
      ]);
      const statuses = [a!.body.status, b!.body.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = [a!, b!].find((r) => r.body.status === 'REJECTED')!;
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect((await getWallet(w.id)).balance.amount).toBe('20.00');
      expect(await debits(w.id)).toBe(1);

    }
  });

  test('2b. retry das mesmas requisições do cenário obrigatório não duplica débito', async () => {
    const w = await createWallet('100.00');
    const betA = { walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '80.00', externalTransactionId: `a-${w.id}` };
    const betB = { walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '80.00', externalTransactionId: `b-${w.id}` };
    const first = await Promise.all([submit(betA, { instance: 0 }), submit(betB, { instance: 2 })]);
    const retries = await Promise.all(
      Array.from({ length: 20 }, (_, i) => submit(i % 2 ? betA : betB, { instance: i })),
    );
    for (const r of retries) {
      const original = first.find((f) => f.body.transactionId === r.body.transactionId)!;
      expect(r.body.status).toBe(original.body.status);
      expect(r.body.idempotentReplay).toBe(true);
    }
    expect((await getWallet(w.id)).balance.amount).toBe('20.00');
    expect(await debits(w.id)).toBe(1);
  });

  test('hot wallet: 150 apostas de 1.00 sobre saldo 100.00 → exatamente 100 aceitas', async () => {
    const w = await createWallet('100.00');
    const responses = await Promise.all(
      Array.from({ length: 150 }, (_, i) => submit({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '1.00' }, { instance: i })),
    );
    expect(responses.filter((r) => r.body.status === 'PROCESSED').length).toBe(100);
    expect(responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS').length).toBe(50);
    expect((await getWallet(w.id)).balance.amount).toBe('0.00');
    expect((await getWallet(w.id)).version).toBe(101);
    expect(await debits(w.id)).toBe(100);
  });

  test('3. wallets distintas processadas em paralelo, sem interferência', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet('50.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 10 }, (_, i) =>
          submit({ walletId: w.id, playerId: w.playerId, kind: i % 2 ? 'WIN' : 'BET', amount: '2.50' }, { instance: i }),
        ),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      const recon = await reconcile(w.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('50.00'); // 5 BET + 5 WIN de 2.50
      expect(recon.checkedEntries).toBe(11);
    }
    // 200 operações em 20 wallets não são serializadas globalmente (sanidade, não benchmark)
    expect(elapsed).toBeLessThan(20_000);
  });

  test('4. três instâncias disputando reversões e apostas da mesma rodada', async () => {
    const w = await createWallet('500.00');
    const bets = Array.from({ length: 20 }, (_, i) => ({
      walletId: w.id,
      playerId: w.playerId,
      kind: 'BET',
      amount: '10.00',
      externalTransactionId: `rb-bet-${i}-${w.id}`,
    }));
    await Promise.all(bets.map((b, i) => submit(b, { instance: i })));
    // para cada aposta, REFUND e ROLLBACK chegam ao mesmo tempo em instâncias diferentes
    const reversals = await Promise.all(
      bets.flatMap((b, i) => [
        submit({ ...b, kind: 'REFUND', externalTransactionId: `rf-${i}-${w.id}`, reference: b.externalTransactionId }, { instance: i }),
        submit({ ...b, kind: 'ROLLBACK', externalTransactionId: `rl-${i}-${w.id}`, reference: b.externalTransactionId }, { instance: i + 1 }),
      ]),
    );
    expect(reversals.filter((r) => r.body.status === 'PROCESSED').length).toBe(20);
    expect(reversals.filter((r) => r.body.failureCode === 'REFERENCE_ALREADY_REVERSED').length).toBe(20);
    expect((await getWallet(w.id)).balance.amount).toBe('500.00');
    expect((await reconcile(w.id)).consistent).toBe(true);
  });

  test('7. REFUND/ROLLBACK entregue antes da referência', async () => {
    const w = await createWallet('100.00');
    const bet = { walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '30.00', externalTransactionId: `late-bet-${w.id}` };
    const refund = await submit({ ...bet, kind: 'REFUND', externalTransactionId: `early-refund-${w.id}`, reference: bet.externalTransactionId }, { instance: 0 });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    expect((await getWallet(w.id)).balance.amount).toBe('100.00');

    const placed = await submit(bet, { instance: 1 });
    expect(placed.body.status).toBe('PROCESSED');
    const after = await submit({ ...bet, kind: 'REFUND', externalTransactionId: `early-refund-${w.id}`, reference: bet.externalTransactionId }, { instance: 2 });
    expect(after.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    expect((await getWallet(w.id)).balance.amount).toBe('100.00');
    expect((await reconcile(w.id)).checkedEntries).toBe(3);
  });

  test('7b. referência e reversão chegando simultaneamente, muitas vezes', async () => {
    const w = await createWallet('1000.00');
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const bet = { walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '5.00', externalTransactionId: `sim-bet-${i}-${w.id}` };
        return Promise.all([
          submit({ ...bet, kind: 'ROLLBACK', externalTransactionId: `sim-rb-${i}-${w.id}`, reference: bet.externalTransactionId }, { instance: i }),
          submit(bet, { instance: i + 1 }),
        ]);
      }),
    );
    const { rows } = await pool.query(
      `select kind, status, count(*)::int as n from wager_transactions where wallet_id = $1 and kind <> 'OPENING' group by 1, 2 order by 1, 2`,
      [w.id],
    );
    // todas as apostas processadas; rollbacks processados na hora ou resolvidos assim que a aposta chegou
    expect(rows.find((r) => r.kind === 'BET')).toEqual({ kind: 'BET', status: 'PROCESSED', n: 30 });
    expect(rows.filter((r) => r.kind === 'ROLLBACK' && r.status === 'REJECTED')).toEqual([]);
    expect((await reconcile(w.id)).consistent).toBe(true);
  });
});
