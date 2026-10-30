import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Container } from '../../src/bootstrap';
import { TransientInfrastructureError } from '../../src/application/errors';
import type { EventPublisher, TransactionScope, UnitOfWork } from '../../src/application/ports';
import { ProcessPendingReferences } from '../../src/application/process-pending-references';
import { PublishOutbox } from '../../src/application/publish-outbox';
import { SubmitWagerTransaction, type SubmitWagerCommand } from '../../src/application/submit-wager-transaction';
import { WagerSettlement } from '../../src/application/wager-settlement';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { PrometheusMetrics } from '../../src/infrastructure/observability/metrics';
import { MikroOrmOutboxStore } from '../../src/infrastructure/persistence/mikro-orm-outbox-store';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { brl, buildTestContainer, closeContainer } from '../support/app';
import { assertLedgerConsistency, createPool, resetDatabase } from '../support/db';
import type pg from 'pg';

/**
 * Integração in-process contra PostgreSQL real (banco jungle_test): atomicidade da transação
 * financeira, outbox com publishers concorrentes e lease, worker de PENDING_REFERENCE e recuperação
 * após reinício.
 */

let c: Container;
let pool: pg.Pool;
const clock = new SystemClock();
const ids = new UuidV7Generator();

beforeAll(async () => {
  await resetDatabase();
  c = await buildTestContainer();
  pool = createPool();
});

afterAll(async () => {
  await assertLedgerConsistency(pool);
  await closeContainer(c);
  await pool.end();
});

async function openWallet(amount = '100.00') {
  const wallet = await c.createWallet.execute({ playerId: crypto.randomUUID(), initialBalance: brl(amount), correlationId: 't' });
  return { walletId: wallet.id, playerId: wallet.playerId };
}

function command(w: { walletId: string; playerId: string }, kind: WagerTransactionKind, amount: string, extra: Partial<SubmitWagerCommand> = {}): SubmitWagerCommand {
  const ext = extra.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
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

/** UnitOfWork real cujo scope falha num ponto escolhido, depois de outras escritas já feitas. */
class FailingUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly failOn: keyof TransactionScope,
  ) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.inner.run((scope) =>
      work(
        new Proxy(scope, {
          get: (target, prop, receiver) => {
            const value = Reflect.get(target, prop, receiver);
            if (prop === this.failOn) {
              return async () => {
                throw new Error(`simulated crash on ${String(prop)}`);
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ),
    );
  }
}

function submitWith(uow: UnitOfWork) {
  const metrics = new PrometheusMetrics();
  return new SubmitWagerTransaction(
    uow,
    new WagerSettlement(clock, ids, { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 1000 }),
    clock,
    ids,
    metrics,
  );
}

async function counts(walletId: string, key: string) {
  const { rows } = await pool.query(
    `select (select count(*)::int from wager_transactions where idempotency_key = $2) as txs,
            (select count(*)::int from wallet_ledger_entries where wallet_id = $1) as entries,
            (select count(*)::int from outbox_messages where aggregate_id = $1) as outbox,
            (select count(*)::int from inbox_messages where message_id = $2) as inbox,
            (select balance_amount::text from wallets where id = $1) as balance`,
    [walletId, key],
  );
  return rows[0];
}

describe('atomicidade: transação, saldo, ledger, inbox e outbox', () => {
  for (const failOn of ['enqueue', 'markInboxProcessed', 'applyLedgerEntryToWallet'] as const) {
    test(`falha em ${failOn} desfaz tudo`, async () => {
      const w = await openWallet();
      const before = await counts(w.walletId, 'none');
      const cmd = command(w, WagerTransactionKind.Bet, '10.00');
      const failing = submitWith(new FailingUnitOfWork(new MikroOrmUnitOfWork(c.orm), failOn));
      await expect(
        failing.execute({
          command: cmd,
          source: { type: 'sqs', messageId: cmd.idempotencyKey, consumerName: 'test', rawBody: '{}' },
          correlationId: 'c',
        }),
      ).rejects.toThrow(/simulated crash/);

      const after = await counts(w.walletId, cmd.idempotencyKey);
      expect(after).toEqual({ ...before, txs: 0, inbox: 0 });
      expect(after.balance).toBe('100.00');

      // e uma nova tentativa (redelivery) aplica exatamente uma vez
      const ok = await c.submit.execute({
        command: cmd,
        source: { type: 'sqs', messageId: cmd.idempotencyKey, consumerName: 'test', rawBody: '{}' },
        correlationId: 'c',
      });
      expect(ok.status as string).toBe('PROCESSED');
      const final = await counts(w.walletId, cmd.idempotencyKey);
      expect(final).toMatchObject({ txs: 1, inbox: 1, entries: before.entries + 1, balance: '90.00' });
      expect(final.outbox).toBe(before.outbox + 2); // Processed + BalanceChanged
    });
  }

  test('LOSS gera evento mas nenhum lançamento', async () => {
    const w = await openWallet();
    const before = await counts(w.walletId, 'none');
    const r = await c.submit.execute({ command: command(w, WagerTransactionKind.Loss, '0.00'), source: { type: 'http' }, correlationId: 'c' });
    expect(r.status as string).toBe('PROCESSED');
    const after = await counts(w.walletId, 'none');
    expect(after.entries).toBe(before.entries);
    expect(after.outbox).toBe(before.outbox + 1);
  });
});

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  constructor(private readonly delayMs = 0, private failNext = 0) {}

  async publish(messages: readonly OutboxMessage[]) {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { published: [], failed: messages.map((m) => ({ id: m.id, error: 'broker down' })) };
    }
    this.published.push(...messages.map((m) => m.id));
    return { published: messages.map((m) => m.id), failed: [] };
  }
}

async function pendingOutbox(): Promise<number> {
  return (await pool.query(`select count(*)::int as n from outbox_messages where published_at is null`)).rows[0].n;
}

describe('outbox', () => {
  test('dois publishers concorrentes publicam cada evento exatamente uma vez', async () => {
    const w = await openWallet('1000.00');
    await Promise.all(
      Array.from({ length: 40 }, () =>
        c.submit.execute({ command: command(w, WagerTransactionKind.Bet, '1.00'), source: { type: 'http' }, correlationId: 'c' }),
      ),
    );
    const pending = await pendingOutbox();
    expect(pending).toBeGreaterThanOrEqual(81);

    const store = new MikroOrmOutboxStore(c.orm);
    const metrics = new PrometheusMetrics();
    const a = new RecordingPublisher(5);
    const b = new RecordingPublisher(5);
    const pa = new PublishOutbox(store, a, clock, metrics, { batchSize: 7, leaseMs: 30_000 });
    const pb = new PublishOutbox(store, b, clock, metrics, { batchSize: 7, leaseMs: 30_000 });
    const drain = async (p: PublishOutbox) => {
      while ((await p.runOnce()).claimed > 0) {
        /* continua até esvaziar */
      }
    };
    await Promise.all([drain(pa), drain(pb), drain(pa), drain(pb)]);

    const all = [...a.published, ...b.published];
    expect(new Set(all).size).toBe(all.length); // nenhum evento publicado por dois publishers
    expect(all.length).toBe(pending);
    expect(a.published.length).toBeGreaterThan(0);
    expect(b.published.length).toBeGreaterThan(0);
    expect(await pendingOutbox()).toBe(0);
  });

  test('publisher que morre depois do claim: outra instância assume após o lease', async () => {
    const w = await openWallet();
    await c.submit.execute({ command: command(w, WagerTransactionKind.Bet, '1.00'), source: { type: 'http' }, correlationId: 'c' });
    const store = new MikroOrmOutboxStore(c.orm);
    const crashed = await store.claimDue(100, 500); // "processo A" reservou e morreu
    expect(crashed.length).toBeGreaterThan(0);

    const b = new RecordingPublisher();
    const pb = new PublishOutbox(store, b, clock, new PrometheusMetrics(), { batchSize: 100, leaseMs: 30_000 });
    expect((await pb.runOnce()).claimed).toBe(0); // lease ainda válido
    await Bun.sleep(600);
    await pb.runOnce();
    expect(b.published.sort()).toEqual(crashed.map((m) => m.id).sort());
    expect(await pendingOutbox()).toBe(0);
  });

  test('falha do broker reagenda com backoff e publica depois', async () => {
    const w = await openWallet();
    await c.submit.execute({ command: command(w, WagerTransactionKind.Bet, '1.00'), source: { type: 'http' }, correlationId: 'c' });
    const store = new MikroOrmOutboxStore(c.orm);
    const flaky = new RecordingPublisher(0, 1);
    const p = new PublishOutbox(store, flaky, clock, new PrometheusMetrics(), { batchSize: 100, leaseMs: 30_000 });
    const first = await p.runOnce();
    expect(first.failed).toBeGreaterThan(0);
    const { rows } = await pool.query(
      `select attempts, last_error, next_attempt_at > now() as delayed from outbox_messages where published_at is null`,
    );
    expect(rows.every((r) => r.attempts === 1 && r.last_error === 'broker down' && r.delayed)).toBe(true);
    await pool.query(`update outbox_messages set next_attempt_at = now() where published_at is null`);
    expect((await p.runOnce()).published).toBe(first.failed);
  });
});

describe('PENDING_REFERENCE', () => {
  test('referência que nunca chega expira como REJECTED/REFERENCE_NOT_FOUND com evento', async () => {
    const w = await openWallet();
    const refund = command(w, WagerTransactionKind.Refund, '10.00', { referenceExternalTransactionId: 'never-arrives' });
    const r = await c.submit.execute({ command: refund, source: { type: 'http' }, correlationId: 'c' });
    expect(r.status as string).toBe('PENDING_REFERENCE');

    const settlement = new WagerSettlement(clock, ids, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 });
    const worker = new ProcessPendingReferences(
      new MikroOrmUnitOfWork(c.orm),
      new MikroOrmOutboxStore(c.orm),
      settlement,
      new PrometheusMetrics(),
      { batchSize: 50, leaseMs: 30_000 },
    );
    const statusOf = async () =>
      (await pool.query(`select status, failure_code, reference_attempts from wager_transactions where idempotency_key = $1`, [refund.idempotencyKey])).rows[0];

    for (let i = 0; i < 10 && (await statusOf()).status === 'PENDING_REFERENCE'; i += 1) {
      await pool.query(`update wager_transactions set next_reference_check_at = now() where idempotency_key = $1 and status = 'PENDING_REFERENCE'`, [refund.idempotencyKey]);
      await worker.runOnce();
    }
    const final = await statusOf();
    expect(final).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    const events = await pool.query(
      `select event_type from outbox_messages where payload->'data'->>'externalTransactionId' = $1 order by occurred_at`,
      [refund.externalTransactionId],
    );
    expect(events.rows.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect((await counts(w.walletId, 'x')).balance).toBe('100.00');
  });

  test('vários workers concorrentes resolvem cada pendente uma única vez', async () => {
    const w = await openWallet('1000.00');
    await pool.query(`update wager_transactions set next_reference_check_at = now() + interval '1 hour' where status = 'PENDING_REFERENCE'`);
    for (let i = 0; i < 15; i += 1) {
      await c.submit.execute({
        command: command(w, WagerTransactionKind.Rollback, '10.00', { referenceExternalTransactionId: `missing-${i}-${w.walletId}` }),
        source: { type: 'http' },
        correlationId: 'c',
      });
    }
    await pool.query(`update wager_transactions set next_reference_check_at = now() where status = 'PENDING_REFERENCE' and wallet_id = $1`, [w.walletId]);

    const makeWorker = () =>
      new ProcessPendingReferences(
        new MikroOrmUnitOfWork(c.orm),
        new MikroOrmOutboxStore(c.orm),
        new WagerSettlement(clock, ids, { maxAttempts: 10, baseDelayMs: 60_000, maxDelayMs: 60_000 }),
        new PrometheusMetrics(),
        { batchSize: 4, leaseMs: 30_000 },
      );
    const results = await Promise.all([makeWorker(), makeWorker(), makeWorker()].map((wk) => wk.runOnce()));
    const claimed = results.reduce((n, r) => n + r.claimed, 0);
    expect(claimed).toBe(12); // 3 workers × lote de 4, sem sobreposição
    const { rows } = await pool.query(
      `select reference_attempts, count(*)::int as n from wager_transactions
        where status = 'PENDING_REFERENCE' and wallet_id = $1 group by 1 order by 1`,
      [w.walletId],
    );
    expect(rows).toEqual([
      { reference_attempts: 0, n: 3 },
      { reference_attempts: 1, n: 12 },
    ]);
  });
});

describe('recuperação após reinício', () => {
  test('commit confirmado, processo morre antes de publicar: nova instância publica tudo', async () => {
    const first = await buildTestContainer();
    const wallet = await first.createWallet.execute({ playerId: crypto.randomUUID(), initialBalance: brl('50.00'), correlationId: 't' });
    const w = { walletId: wallet.id, playerId: wallet.playerId };
    for (let i = 0; i < 5; i += 1) {
      await first.submit.execute({ command: command(w, WagerTransactionKind.Bet, '1.00'), source: { type: 'http' }, correlationId: 'c' });
    }
    await first.orm.close(true); // "kill": nada publicado, conexões encerradas
    first.sqs.destroy();

    const second = await buildTestContainer();
    try {
      const recording = new RecordingPublisher();
      const publisher = new PublishOutbox(new MikroOrmOutboxStore(second.orm), recording, clock, new PrometheusMetrics(), { batchSize: 100, leaseMs: 30_000 });
      while ((await publisher.runOnce()).claimed > 0) {
        /* drena */
      }
      const forWallet = await pool.query(`select id from outbox_messages where aggregate_id = $1`, [w.walletId]);
      expect(forWallet.rows.length).toBe(11); // abertura + 5 × (Processed + BalanceChanged)
      expect(forWallet.rows.every((r) => recording.published.includes(r.id))).toBe(true);
      const recon = await second.reconcile.execute(w.walletId);
      expect(recon).toMatchObject({ consistent: true, storedBalance: brl('45.00'), checkedEntries: 6 });
    } finally {
      await closeContainer(second);
    }
  });

  test('erro transitório do banco é traduzido e não deixa efeito parcial', async () => {
    const w = await openWallet();
    const cmd = command(w, WagerTransactionKind.Bet, '1.00');
    const lockHolder = await pool.connect();
    try {
      await lockHolder.query('begin');
      await lockHolder.query('select * from wallets where id = $1 for update', [w.walletId]);
      const shortLock = await buildTestContainer();
      try {
        await shortLock.orm.em.getConnection().execute('select 1');
        const started = Date.now();
        await expect(shortLock.submit.execute({ command: cmd, source: { type: 'http' }, correlationId: 'c' })).rejects.toBeInstanceOf(
          TransientInfrastructureError,
        );
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        await closeContainer(shortLock);
      }
    } finally {
      await lockHolder.query('rollback');
      lockHolder.release();
    }
    expect((await counts(w.walletId, cmd.idempotencyKey)).txs).toBe(0);
  }, 30_000);
});
