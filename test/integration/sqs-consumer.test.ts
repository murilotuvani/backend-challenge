import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import type { Container } from '../../src/bootstrap';
import { TransientInfrastructureError } from '../../src/application/errors';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { brl, buildTestContainer, closeContainer } from '../support/app';
import { assertLedgerConsistency, createPool, resetDatabase } from '../support/db';
import { eventually } from '../support/api';
import { countMessages, createQueuePair, receiveAll, sendWager, wagerMessage } from '../support/sqs';

/**
 * Consumidor SQS real contra LocalStack real e PostgreSQL real, com filas exclusivas por teste
 * (redrive para DLQ com maxReceiveCount = 3).
 */

let pool: pg.Pool;
let setup: Container;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  await resetDatabase();
  pool = createPool();
  setup = await buildTestContainer();
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

afterAll(async () => {
  await assertLedgerConsistency(pool);
  await closeContainer(setup);
  await pool.end();
});

async function walletWith(amount: string) {
  const w = await setup.createWallet.execute({ playerId: crypto.randomUUID(), initialBalance: brl(amount), correlationId: 't' });
  return { walletId: w.id, playerId: w.playerId };
}

function data(w: { walletId: string; playerId: string }, ext: string, kind = 'BET', amount = '10.00', extra = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl(amount),
    ...extra,
  };
}

async function consumerOn(queues: { name: string; dlqName: string }, maxReceiveCount = 3) {
  const c = await buildTestContainer({
    sqs: { wagerQueueName: queues.name, wagerDlqName: queues.dlqName, maxReceiveCount, shutdownGraceMs: 10_000 },
  });
  await c.consumer.start();
  cleanups.push(() => closeContainer(c));
  return c;
}

async function queues() {
  const q = await createQueuePair('it', 3);
  cleanups.push(() => q.destroy());
  return q;
}

const ledgerCount = async (walletId: string) =>
  (await pool.query(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1`, [walletId])).rows[0].n;
const balance = async (walletId: string) =>
  (await pool.query(`select balance_amount::text as b from wallets where id = $1`, [walletId])).rows[0].b;

describe('consumidor SQS', () => {
  test('redelivery da mesma mensagem é descartada pela inbox persistente', async () => {
    const q = await queues();
    const w = await walletWith('100.00');
    const body = wagerMessage('msg-dup', data(w, 'dup-1'));
    await sendWager(q.url, w.walletId, body);
    await sendWager(q.url, w.walletId, body);
    await sendWager(q.url, w.walletId, wagerMessage('msg-other', data(w, 'dup-1'))); // outra mensagem, mesma key → replay
    const c = await consumerOn(q);

    await eventually(() => countMessages(q.url), (n) => n === 0);
    expect(await balance(w.walletId)).toBe('90.00');
    expect(await ledgerCount(w.walletId)).toBe(2); // abertura + 1 débito
    const inbox = await pool.query(`select message_id, processed_at is not null as done from inbox_messages where message_id in ('msg-dup','msg-other') order by 1`);
    expect(inbox.rows).toEqual([
      { message_id: 'msg-dup', done: true },
      { message_id: 'msg-other', done: true },
    ]);
    const metrics = await c.metrics.registry.getSingleMetricAsString('inbox_duplicates_total');
    expect(metrics).toContain('inbox_duplicates_total 1');
  });

  test('rejeição de negócio é terminal: ack, sem retry', async () => {
    const q = await queues();
    const w = await walletWith('5.00');
    await sendWager(q.url, w.walletId, wagerMessage('msg-poor', data(w, 'poor-1', 'BET', '10.00')));
    await consumerOn(q);
    await eventually(() => countMessages(q.url), (n) => n === 0);
    const tx = await pool.query(`select status, failure_code from wager_transactions where external_transaction_id = 'poor-1'`);
    expect(tx.rows[0]).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await countMessages(q.dlqUrl)).toBe(0);
  });

  test('payload inválido e wallet inexistente vão direto para a DLQ (permanente)', async () => {
    const q = await queues();
    const w = await walletWith('5.00');
    await sendWager(q.url, 'g1', 'not json');
    await sendWager(q.url, 'g2', wagerMessage('msg-bad-money', data(w, 'bad-1', 'BET', '10.0')));
    await sendWager(q.url, 'g3', wagerMessage('msg-opening', data(w, 'bad-2', 'OPENING', '10.00')));
    await sendWager(q.url, 'g4', wagerMessage('msg-no-wallet', data({ walletId: crypto.randomUUID(), playerId: w.playerId }, 'bad-3')));
    await consumerOn(q);
    await eventually(() => countMessages(q.dlqUrl), (n) => n === 4);
    expect(await countMessages(q.url)).toBe(0);
    const dead = await receiveAll(q.dlqUrl);
    const reasons = dead.map((m) => m.MessageAttributes?.failureReason?.StringValue?.split(':')[0]).sort();
    expect(reasons).toEqual(['WALLET_NOT_FOUND', 'invalid_payload', 'invalid_payload', 'invalid_payload']);
  });

  test('falha transitória: retry com backoff e sucesso sem duplicar', async () => {
    const q = await queues();
    const w = await walletWith('100.00');
    let failures = 2;
    const original = SubmitWagerTransaction.prototype.execute;
    const c = await consumerOn(q);
    const spy = function (this: SubmitWagerTransaction, input: Parameters<typeof original>[0]) {
      if (input.command.externalTransactionId === 'flaky-1' && failures > 0) {
        failures -= 1;
        return Promise.reject(new TransientInfrastructureError('simulated db outage'));
      }
      return original.call(this, input);
    };
    c.submit.execute = spy.bind(c.submit) as typeof original;
    await sendWager(q.url, w.walletId, wagerMessage('msg-flaky', data(w, 'flaky-1')));

    await eventually(() => balance(w.walletId), (b) => b === '90.00', 30_000);
    expect(failures).toBe(0);
    expect(await ledgerCount(w.walletId)).toBe(2);
    expect(await c.metrics.registry.getSingleMetricAsString('sqs_retries_total')).toContain('sqs_retries_total 2');
  }, 40_000);

  test('tentativas esgotadas: DLQ e transação registrada como FAILED (auditável)', async () => {
    const q = await queues();
    const w = await walletWith('100.00');
    const c = await consumerOn(q, 3);
    c.submit.execute = () => Promise.reject(new TransientInfrastructureError('db down for good'));
    await sendWager(q.url, w.walletId, wagerMessage('msg-doomed', data(w, 'doomed-1')));

    await eventually(() => countMessages(q.dlqUrl), (n) => n === 1, 40_000);
    const tx = await pool.query(`select status, failure_code from wager_transactions where external_transaction_id = 'doomed-1'`);
    expect(tx.rows[0]).toEqual({ status: 'FAILED', failure_code: 'INFRA_PERMANENT_FAILURE' });
    expect(await balance(w.walletId)).toBe('100.00');
    const [dead] = await receiveAll(q.dlqUrl);
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('retries_exhausted');
  }, 60_000);

  test('worker morto depois do commit e antes do ack: redelivery não duplica', async () => {
    const q = await queues();
    const w = await walletWith('100.00');
    await sendWager(q.url, w.walletId, wagerMessage('msg-crash', data(w, 'crash-1')));

    const child = Bun.spawn(['bun', 'run', 'test/support/crash-consumer.ts', q.name, q.dlqName], {
      env: { ...process.env, LOG_LEVEL: 'silent' },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    const out = await new Response(child.stdout).text();
    expect(exitCode).toBe(137);
    expect(out).toContain('committed');
    expect(await balance(w.walletId)).toBe('90.00'); // commit aconteceu
    expect(await countMessages(q.url)).toBe(1); // sem ack: a mensagem continua na fila

    const c = await consumerOn(q);
    await eventually(() => countMessages(q.url), (n) => n === 0, 20_000);
    expect(await balance(w.walletId)).toBe('90.00');
    expect(await ledgerCount(w.walletId)).toBe(2);
    expect(await c.metrics.registry.getSingleMetricAsString('inbox_duplicates_total')).toContain('inbox_duplicates_total 1');
  }, 40_000);

  test('SIGTERM: mensagens em andamento terminam antes do encerramento', async () => {
    const q = await queues();
    const w = await walletWith('100.00');
    const c = await consumerOn(q);
    const original = c.submit.execute.bind(c.submit);
    let started = 0;
    c.submit.execute = async (input) => {
      started += 1;
      await Bun.sleep(1_500);
      return original(input);
    };
    for (let i = 0; i < 3; i += 1) {
      await sendWager(q.url, w.walletId, wagerMessage(`msg-slow-${i}`, data(w, `slow-${i}`, 'BET', '1.00')));
    }
    await eventually(async () => started, (n) => n >= 1, 10_000);
    await c.consumer.stop();

    const done = await pool.query(`select count(*)::int as n from wager_transactions where external_transaction_id like 'slow-%'`);
    // o que começou terminou e foi confirmado; o resto voltou para a fila, nada se perdeu
    expect(done.rows[0].n).toBeGreaterThanOrEqual(1);
    const next = await consumerOn(q);
    await eventually(() => countMessages(q.url), (n) => n === 0, 20_000);
    expect(await balance(w.walletId)).toBe('97.00');
    void next;
  }, 40_000);
});
