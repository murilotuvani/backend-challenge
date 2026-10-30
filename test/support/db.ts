import { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { env } from './env';

/** Conexão direta para os testes inspecionarem o banco real (nunca mock). */
export function createPool(database: string = env.testDbName, max = 20): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST ?? 'postgres',
    port: Number(process.env.DB_PORT ?? 5432),
    database,
    user: process.env.DB_USER ?? 'chimp',
    password: process.env.DB_PASSWORD ?? 'CaptainFox&Parrot',
    max,
  });
}

/** Recria o schema do banco de testes do zero e aplica todas as migrations. */
export async function resetDatabase(): Promise<void> {
  const pool = createPool(env.testDbName, 1);
  try {
    await pool.query('drop schema if exists public cascade; create schema public;');
  } finally {
    await pool.end();
  }
  const orm = await MikroORM.init(buildOrmConfig({ poolMax: 1, dbName: env.testDbName }));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

/** Executa um bloco em uma transação explícita e faz commit (onde rodam os triggers deferred). */
export async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Invariante final de todos os testes: saldo materializado == saldo reconstruído pelo ledger. */
export async function assertLedgerConsistency(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ id: string; balance: string; calculated: string }>(`
    select w.id, w.balance_amount::text as balance,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20,2)::text as calculated
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
     group by w.id, w.balance_amount
  `);
  const divergent = rows.filter((r) => r.balance !== r.calculated);
  if (divergent.length > 0) {
    throw new Error(`Ledger divergence: ${JSON.stringify(divergent)}`);
  }
}
