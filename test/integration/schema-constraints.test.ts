import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type pg from 'pg';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { assertLedgerConsistency, createPool, inTransaction, resetDatabase } from '../support/db';
import { env } from '../support/env';

/**
 * Garante que as invariantes estão no schema, não só no código: cada teste escreve SQL "malicioso"
 * direto no banco, contornando a aplicação, e espera que o PostgreSQL recuse.
 */

const HASH = 'a'.repeat(64);
let pool: pg.Pool;
let seq = 0;

const uuid = () => crypto.randomUUID();

async function insertWallet(client: pg.PoolClient | pg.Pool, balance = '0.00', id = uuid(), player = uuid()) {
  await client.query(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values ($1, $2, 'BRL', $3, 1, now(), now())`,
    [id, player, balance],
  );
  return id;
}

async function insertTx(
  client: pg.PoolClient | pg.Pool,
  walletId: string,
  opts: { kind?: string; status?: string; amount?: string; referenceTxId?: string; refExt?: string; failure?: string } = {},
) {
  const id = uuid();
  seq += 1;
  const status = opts.status ?? 'PROCESSED';
  await client.query(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
        status, failure_code, processed_at, created_at, updated_at)
     values ($1, 'provider-a', $2, $3, $4, $5, $6, 'r1', 'g1', $7, $8, 'BRL', $9, $10, $11, $12,
             case when $11 = 'PROCESSED' then now() end, now(), now())`,
    [
      id,
      `ext-${seq}`,
      `provider-a:ext-${seq}`,
      HASH,
      walletId,
      uuid(),
      opts.kind ?? 'BET',
      opts.amount ?? '10.00',
      opts.refExt ?? (opts.referenceTxId ? 'ref' : null),
      opts.referenceTxId ?? null,
      status,
      opts.failure ?? (status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null),
    ],
  );
  return id;
}

async function insertEntry(
  client: pg.PoolClient | pg.Pool,
  walletId: string,
  txId: string,
  e: { direction: string; amount: string; before: string; after: string; version: number },
) {
  await client.query(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before_amount, balance_after_amount,
        wallet_version, created_at)
     values ($1, $2, $3, $4, $5, 'BRL', $6, $7, $8, now())`,
    [uuid(), walletId, txId, e.direction, e.amount, e.before, e.after, e.version],
  );
}

/** Cria uma wallet com saldo 100.00 de forma válida (wallet + OPENING + lançamento na mesma transação). */
async function walletWithBalance(): Promise<string> {
  return inTransaction(pool, async (c) => {
    const w = await insertWallet(c, '100.00');
    const t = await insertTx(c, w, { kind: 'OPENING', amount: '100.00' });
    await insertEntry(c, w, t, { direction: 'CREDIT', amount: '100.00', before: '0.00', after: '100.00', version: 1 });
    return w;
  });
}

beforeAll(async () => {
  await resetDatabase();
  pool = createPool();
});

afterAll(async () => {
  await assertLedgerConsistency(pool);
  await pool.end();
});

describe('migrations', () => {
  test('são reversíveis: down remove tudo e up recria', async () => {
    const orm = await MikroORM.init(buildOrmConfig({ poolMax: 1, dbName: env.testDbName }));
    try {
      await orm.getMigrator().down({ to: 0 });
      const after = await pool.query(`select count(*)::int as n from pg_tables where schemaname='public' and tablename <> 'mikro_orm_migrations'`);
      expect(after.rows[0].n).toBe(0);
      await orm.getMigrator().up();
      const tables = await pool.query(`select tablename from pg_tables where schemaname='public' order by 1`);
      expect(tables.rows.map((r) => r.tablename)).toEqual([
        'inbox_messages',
        'mikro_orm_migrations',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]);
    } finally {
      await orm.close(true);
    }
  });
});

describe('wallets', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    await expect(insertWallet(pool, '-0.01')).rejects.toThrow(/wallets_balance_non_negative_ck/);
  });

  test('uma wallet por player e moeda', async () => {
    const player = uuid();
    await insertWallet(pool, '0.00', uuid(), player);
    await expect(insertWallet(pool, '0.00', uuid(), player)).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test('saldo inicial positivo sem lançamento de abertura falha no commit', async () => {
    await expect(inTransaction(pool, (c) => insertWallet(c, '50.00'))).rejects.toThrow(/no matching ledger entry/);
  });

  test('mudança de saldo sem lançamento falha no commit (read-calculate-update cego)', async () => {
    const w = await walletWithBalance();
    await expect(
      inTransaction(pool, (c) => c.query(`update wallets set balance_amount = 999.00, version = 2 where id = $1`, [w])),
    ).rejects.toThrow(/no matching ledger entry/);
  });

  test('mudança de saldo com lançamento encadeado é aceita', async () => {
    const w = await walletWithBalance();
    await inTransaction(pool, async (c) => {
      const t = await insertTx(c, w, { kind: 'BET', amount: '80.00' });
      await insertEntry(c, w, t, { direction: 'DEBIT', amount: '80.00', before: '100.00', after: '20.00', version: 2 });
      await c.query(`update wallets set balance_amount = 20.00, version = 2 where id = $1`, [w]);
    });
    const { rows } = await pool.query(`select balance_amount::text as b, version from wallets where id = $1`, [w]);
    expect(rows[0]).toEqual({ b: '20.00', version: 2 });
  });

  test('lançamento com balance_before diferente do saldo anterior é recusado', async () => {
    const w = await walletWithBalance();
    expect(
      inTransaction(pool, async (c) => {
        const t = await insertTx(c, w, { kind: 'WIN', amount: '10.00' });
        await insertEntry(c, w, t, { direction: 'CREDIT', amount: '10.00', before: '50.00', after: '60.00', version: 2 });
        await c.query(`update wallets set balance_amount = 60.00, version = 2 where id = $1`, [w]);
      }),
    ).rejects.toThrow(/no matching ledger entry/);
  });

  test('version só muda junto com o saldo, de 1 em 1', async () => {
    const w = await walletWithBalance();
    await expect(pool.query(`update wallets set version = 5 where id = $1`, [w])).rejects.toThrow(/version may only change/);
    await expect(pool.query(`update wallets set balance_amount = 1.00, version = 9 where id = $1`, [w])).rejects.toThrow(
      /increment by exactly 1/,
    );
  });

  test('wallets não podem ser apagadas nem trocar de dono', async () => {
    const w = await walletWithBalance();
    await expect(pool.query(`delete from wallets where id = $1`, [w])).rejects.toThrow(/cannot be deleted/);
    await expect(pool.query(`update wallets set player_id = $2 where id = $1`, [w, uuid()])).rejects.toThrow(/immutable/);
  });
});

describe('ledger', () => {
  test('é append-only: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    await walletWithBalance();
    await expect(pool.query(`update wallet_ledger_entries set amount = 1.00`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from wallet_ledger_entries`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`truncate wallet_ledger_entries cascade`)).rejects.toThrow(/append-only/);
  });

  test('lançamento desbalanceado é recusado', async () => {
    const w = await walletWithBalance();
    const t = await insertTx(pool, w, { kind: 'WIN', status: 'PENDING' });
    await expect(
      insertEntry(pool, w, t, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '120.00', version: 2 }),
    ).rejects.toThrow(/wallet_ledger_entries_balanced_ck/);
  });

  test('no máximo um lançamento por transação e wallet', async () => {
    const w = await walletWithBalance();
    expect(
      inTransaction(pool, async (c) => {
        const t = await insertTx(c, w, { kind: 'WIN', amount: '10.00' });
        await insertEntry(c, w, t, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '110.00', version: 2 });
        await insertEntry(c, w, t, { direction: 'CREDIT', amount: '10.00', before: '110.00', after: '120.00', version: 3 });
      }),
    ).rejects.toThrow(/wallet_ledger_entries_transaction_wallet_uq/);
  });

  test('lançamento sem mudança de saldo correspondente falha no commit', async () => {
    const w = await walletWithBalance();
    expect(
      inTransaction(pool, async (c) => {
        const t = await insertTx(c, w, { kind: 'WIN', amount: '10.00' });
        await insertEntry(c, w, t, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '110.00', version: 2 });
      }),
    ).rejects.toThrow(/never reached/);
  });
});

describe('wager_transactions', () => {
  test('idempotency key e (provider, external id) são únicos', async () => {
    const w = await walletWithBalance();
    await pool.query(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       values ($1, 'p', 'x1', 'k-dup', $2, $3, $4, 'r', 'g', 'BET', 1.00, 'BRL', 'PENDING', now(), now())`,
      [uuid(), HASH, w, uuid()],
    );
    await expect(
      pool.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
         values ($1, 'p', 'x2', 'k-dup', $2, $3, $4, 'r', 'g', 'BET', 1.00, 'BRL', 'PENDING', now(), now())`,
        [uuid(), HASH, w, uuid()],
      ),
    ).rejects.toThrow(/wager_transactions_idempotency_key_uq/);
    await expect(
      pool.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
         values ($1, 'p', 'x1', 'k-other', $2, $3, $4, 'r', 'g', 'BET', 1.00, 'BRL', 'PENDING', now(), now())`,
        [uuid(), HASH, w, uuid()],
      ),
    ).rejects.toThrow(/wager_transactions_provider_external_uq/);
  });

  test('REFUND/ROLLBACK sem referência é recusado', async () => {
    const w = await walletWithBalance();
    await expect(insertTx(pool, w, { kind: 'REFUND', status: 'PENDING' })).rejects.toThrow(
      /reversal_requires_reference_ck/,
    );
  });

  test('uma transação só pode ser revertida uma vez, por qualquer tipo', async () => {
    const w = await walletWithBalance();
    const bet = await insertTx(pool, w, { kind: 'BET', status: 'PROCESSED' });
    await insertTx(pool, w, { kind: 'REFUND', status: 'PROCESSED', referenceTxId: bet });
    await expect(insertTx(pool, w, { kind: 'ROLLBACK', status: 'PROCESSED', referenceTxId: bet })).rejects.toThrow(
      /wager_transactions_single_reversal_uq/,
    );
    // rejeitadas não contam como reversão
    await insertTx(pool, w, { kind: 'REFUND', status: 'REJECTED', referenceTxId: bet, failure: 'REFERENCE_ALREADY_REVERSED' });
  });

  test('referência precisa pertencer à mesma wallet', async () => {
    const w1 = await walletWithBalance();
    const w2 = await walletWithBalance();
    const bet = await insertTx(pool, w1, { kind: 'BET', status: 'PROCESSED' });
    await expect(insertTx(pool, w2, { kind: 'REFUND', status: 'PENDING', referenceTxId: bet })).rejects.toThrow(
      /reference_same_wallet_fk/,
    );
  });

  test('estados terminais são imutáveis e transações não podem ser apagadas', async () => {
    const w = await walletWithBalance();
    const t = await insertTx(pool, w, { kind: 'BET', status: 'REJECTED' });
    await expect(pool.query(`update wager_transactions set status = 'PROCESSED', processed_at = now(), failure_code = null where id = $1`, [t])).rejects.toThrow(
      /is terminal/,
    );
    await expect(pool.query(`delete from wager_transactions where id = $1`, [t])).rejects.toThrow(/cannot be deleted/);
  });

  test('colunas de identidade não mudam mesmo em estados não terminais', async () => {
    const w = await walletWithBalance();
    const t = await insertTx(pool, w, { kind: 'BET', status: 'PENDING' });
    await expect(pool.query(`update wager_transactions set amount = 99.00 where id = $1`, [t])).rejects.toThrow(/immutable/);
  });

  test('REJECTED exige failure_code', async () => {
    const w = await walletWithBalance();
    const t = await insertTx(pool, w, { kind: 'BET', status: 'PENDING' });
    await expect(pool.query(`update wager_transactions set status = 'REJECTED' where id = $1`, [t])).rejects.toThrow(
      /failure_code_ck/,
    );
  });
});

describe('inbox', () => {
  test('(consumer, message) é único', async () => {
    await pool.query(`insert into inbox_messages values ('c', 'm1', $1, now(), null)`, [HASH]);
    await expect(pool.query(`insert into inbox_messages values ('c', 'm1', $1, now(), null)`, [HASH])).rejects.toThrow(
      /inbox_messages_pk/,
    );
    await pool.query(`insert into inbox_messages values ('other', 'm1', $1, now(), null)`, [HASH]);
  });
});

beforeEach(() => {
  seq += 1000;
});
