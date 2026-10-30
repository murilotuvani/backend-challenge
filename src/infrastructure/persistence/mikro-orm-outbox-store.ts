import type { MikroORM } from '@mikro-orm/postgresql';
import type { ClaimedTransaction, OutboxStore } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMapper } from './mappers';
import { translatePersistenceError } from './pg-errors';
import type { OutboxRecord } from './schemas';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
}

/** Em queries cruas o driver (configurado pelo MikroORM) devolve timestamptz como string. */
const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/**
 * Operações de "fila no banco" (outbox e PENDING_REFERENCE). O claim é um UPDATE ... RETURNING sobre
 * um SELECT ... FOR UPDATE SKIP LOCKED: várias instâncias disputam sem bloquear umas às outras, e o
 * lease (locked_until / next_reference_check_at) garante que uma instância morta libera o trabalho.
 */
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.exec<OutboxRow[]>(
      `update outbox_messages o
          set locked_until = now() + (? * interval '1 millisecond')
        where o.id in (
          select id from outbox_messages
           where published_at is null
             and next_attempt_at <= now()
             and (locked_until is null or locked_until < now())
           order by next_attempt_at, occurred_at
           limit ?
           for update skip locked)
        returning o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at, o.published_at`,
      [leaseMs, limit],
    );
    return rows
      .sort((a, b) => toDate(a.occurred_at).getTime() - toDate(b.occurred_at).getTime())
      .map((r) =>
        OutboxMapper.toDomain({
          id: r.id,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload: typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload,
          occurredAt: toDate(r.occurred_at),
          attempts: r.attempts,
          nextAttemptAt: toDate(r.next_attempt_at),
          publishedAt: r.published_at === null ? null : toDate(r.published_at),
        } as OutboxRecord),
      );
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.exec(
      `update outbox_messages set published_at = ?, locked_until = null, last_error = null
        where id = any(?::uuid[]) and published_at is null`,
      [at, `{${ids.join(',')}}`],
    );
  }

  async scheduleRetry(message: OutboxMessage, error: string): Promise<void> {
    await this.exec(
      `update outbox_messages set attempts = ?, next_attempt_at = ?, locked_until = null, last_error = ?
        where id = ? and published_at is null`,
      [message.attempts, message.nextAttemptAt, error.slice(0, 1000), message.id],
    );
  }

  async lag(_now: Date): Promise<{ oldestAgeSeconds: number; pending: number }> {
    const rows = await this.exec<{ age: string | null; pending: string }[]>(
      `select extract(epoch from (now() - min(occurred_at)))::text as age, count(*)::text as pending
         from outbox_messages where published_at is null`,
    );
    const row = rows[0];
    return {
      oldestAgeSeconds: row?.age ? Number.parseFloat(row.age) : 0,
      pending: row ? Number.parseInt(row.pending, 10) : 0,
    };
  }

  async claimDuePendingReferences(limit: number, leaseMs: number): Promise<ClaimedTransaction[]> {
    const rows = await this.exec<{ id: string; wallet_id: string }[]>(
      `update wager_transactions t
          set next_reference_check_at = now() + (? * interval '1 millisecond')
        where t.id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and next_reference_check_at <= now()
           order by next_reference_check_at
           limit ?
           for update skip locked)
        returning t.id, t.wallet_id`,
      [leaseMs, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  private async exec<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    try {
      return (await this.orm.em.fork().execute(sql, params)) as T;
    } catch (err) {
      throw translatePersistenceError(err);
    }
  }
}
