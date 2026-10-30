import { afterAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { createWallet, eventually, reconcile, wagerBody, tokenFor } from '../support/api';
import { assertLedgerConsistency, createPool } from '../support/db';
import { isDockerAvailable, kill, restart, start, waitReady } from '../support/docker';
import { env } from '../support/env';
import { queueUrl, sendWager, wagerMessage, countMessages } from '../support/sqs';

/**
 * 5 e 8: instâncias derrubadas no meio do processamento (SIGKILL, sem chance de ack/commit limpo)
 * e reiniciadas, enquanto HTTP e SQS continuam chegando. Ao final, prova a consistência:
 * cada operação confirmada existe exatamente uma vez, saldo == ledger, outbox drenada.
 */

const pool: pg.Pool = createPool(env.appDbName);
const dockerAvailable = await isDockerAvailable();

afterAll(async () => {
  await assertLedgerConsistency(pool);
  await pool.end();
});

/** Cliente "provedor" realista: reenvia com a mesma Idempotency-Key em erro de rede ou 503, trocando de instância. */
async function submitWithRetry(body: ReturnType<typeof wagerBody>, startAt: number) {
  const token = await tokenFor(body.providerId);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const url = env.appUrls[(startAt + attempt) % env.appUrls.length]!;
    try {
      const res = await fetch(`${url}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 503 || res.status >= 500) {
        await Bun.sleep(100);
        continue;
      }
      return { status: res.status, body: (await res.json()) as { status: string }, attempts: attempt + 1 };
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`gave up on ${body.externalTransactionId}`);
}

describe.skipIf(!dockerAvailable)('falhas de processo', () => {
  test('SIGKILL e restart de instâncias durante carga HTTP + SQS: consistência final comprovada', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet('1000.00')));
    const wagerQueue = await queueUrl('wager-transactions.fifo');
    const bodies = wallets.flatMap((w) =>
      Array.from({ length: 40 }, (_, i) =>
        wagerBody({ walletId: w.id, playerId: w.playerId, kind: i % 4 === 3 ? 'WIN' : 'BET', amount: '3.00', externalTransactionId: `chaos-${i}-${w.id}` }),
      ),
    );
    const sqsBodies = wallets.flatMap((w) =>
      Array.from({ length: 10 }, (_, i) => ({
        ...wagerBody({ walletId: w.id, playerId: w.playerId, kind: 'BET', amount: '1.00', externalTransactionId: `chaos-sqs-${i}-${w.id}` }),
        idempotencyKey: `provider-a:chaos-sqs-${i}-${w.id}`,
      })),
    );

    const chaos = (async () => {
      await Bun.sleep(300);
      await kill('app-2'); // morte abrupta: requisições e mensagens em andamento ficam sem resposta/ack
      await Bun.sleep(1_000);
      await restart('app-3', 10); // SIGTERM: encerramento gracioso
      await start('app-2');
    })();

    const http = Promise.all(bodies.map((b, i) => Bun.sleep((i % 40) * 25).then(() => submitWithRetry(b, i))));
    for (const [i, b] of sqsBodies.entries()) {
      await sendWager(wagerQueue, b.walletId, wagerMessage(`chaos-msg-${b.externalTransactionId}`, b));
      if (i % 5 === 0) {
        // redelivery proposital da mesma mensagem
        await sendWager(wagerQueue, b.walletId, wagerMessage(`chaos-msg-${b.externalTransactionId}`, b));
      }
    }
    const results = await http;
    await chaos;
    await Promise.all(env.appUrls.map((u) => waitReady(u)));

    // toda operação HTTP confirmada (2xx/422) existe exatamente uma vez
    expect(results.every((r) => [200, 201, 422].includes(r.status))).toBe(true);
    const keys = bodies.map((b) => `${b.providerId}:${b.externalTransactionId}`);
    const persisted = await pool.query(
      `select idempotency_key, count(*)::int as n from wager_transactions where idempotency_key = any($1) group by 1`,
      [keys],
    );
    expect(persisted.rows.length).toBe(keys.length);
    expect(persisted.rows.every((r) => r.n === 1)).toBe(true);

    // a fila é drenada mesmo com instâncias mortas no meio (visibility timeout + inbox)
    await eventually(() => countMessages(wagerQueue), (n) => n === 0, 90_000);
    const sqsKeys = sqsBodies.map((b) => b.idempotencyKey);
    const sqsPersisted = await pool.query(`select count(*)::int as n from wager_transactions where idempotency_key = any($1)`, [sqsKeys]);
    expect(sqsPersisted.rows[0].n).toBe(sqsKeys.length);

    // saldo esperado calculado a partir do que o banco diz que foi processado, e conferido com o ledger
    for (const w of wallets) {
      const recon = await reconcile(w.id);
      expect(recon.consistent).toBe(true);
      // cálculo esperado feito no banco (NUMERIC), nunca em ponto flutuante
      const { rows } = await pool.query(
        `select (1000.00 + coalesce(sum(case when kind = 'WIN' then amount else -amount end), 0))::numeric(20,2)::text as expected
           from wager_transactions where wallet_id = $1 and status = 'PROCESSED' and kind in ('BET','WIN')`,
        [w.id],
      );
      expect(recon.storedBalance.amount).toBe(rows[0].expected);
    }

    // a outbox de todos os commits é publicada depois da recuperação (nenhum evento confirmado se perde)
    await eventually(
      async () => (await pool.query(`select count(*)::int as n from outbox_messages where published_at is null`)).rows[0].n,
      (n) => n === 0,
      60_000,
    );
  }, 180_000);
});
