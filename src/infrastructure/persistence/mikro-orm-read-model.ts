import type { MikroORM } from '@mikro-orm/postgresql';
import type { LedgerPage, ReadModel, ReconciliationSnapshot } from '../../application/ports';
import { Money } from '../../domain/money';
import { LedgerEntryMapper, TransactionMapper, WalletMapper, amountToString } from './mappers';
import { translatePersistenceError } from './pg-errors';
import { LedgerEntrySchema, WagerTransactionSchema, WalletSchema } from './schemas';

export class MikroOrmReadModel implements ReadModel {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string) {
    return this.guard(async () => {
      const r = await this.orm.em.fork().findOne(WalletSchema, { id: walletId });
      return r ? WalletMapper.toDomain(r) : undefined;
    });
  }

  async findTransaction(transactionId: string) {
    return this.guard(async () => {
      const r = await this.orm.em.fork().findOne(WagerTransactionSchema, { id: transactionId });
      return r ? TransactionMapper.toDomain(r) : undefined;
    });
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string) {
    return this.guard(async () => {
      const r = await this.orm.em.fork().findOne(WagerTransactionSchema, { providerId, externalTransactionId });
      return r ? TransactionMapper.toDomain(r) : undefined;
    });
  }

  async ledgerPage(walletId: string, limit: number, beforeVersion: number | undefined): Promise<LedgerPage> {
    return this.guard(async () => {
      const rows = await this.orm.em.fork().find(
        LedgerEntrySchema,
        beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: beforeVersion } },
        { orderBy: { walletVersion: 'desc' }, limit: limit + 1 },
      );
      const page = rows.slice(0, limit).map((r) => LedgerEntryMapper.toDomain(r));
      const last = page[page.length - 1];
      return {
        entries: page,
        nextCursor: rows.length > limit && last ? encodeCursor(last.walletVersion) : undefined,
      };
    });
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    return this.guard(async () => {
      // Uma única instrução: wallet e ledger vêm do mesmo snapshot, mesmo em READ COMMITTED.
      const rows = await this.orm.em.fork().execute<
        {
          currency: string;
          stored: string;
          calculated: string;
          version: number;
          entries: string;
          last_version: number | null;
          last_after: string | null;
        }[]
      >(
        `select w.currency,
                w.balance_amount::text as stored,
                coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20,2)::text as calculated,
                w.version,
                count(e.id)::text as entries,
                max(e.wallet_version) as last_version,
                (select l.balance_after_amount::text from wallet_ledger_entries l
                  where l.wallet_id = w.id order by l.wallet_version desc limit 1) as last_after
           from wallets w
           left join wallet_ledger_entries e on e.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      const currency = row.currency.trim();
      return {
        storedBalance: Money.rehydrate(amountToString(row.stored), currency),
        calculatedBalance: Money.rehydrate(amountToString(row.calculated), currency),
        checkedEntries: Number.parseInt(row.entries, 10),
        walletVersion: row.version,
        lastEntryVersion: row.last_version ?? undefined,
        lastEntryBalanceAfter: row.last_after ? Money.rehydrate(amountToString(row.last_after), currency) : undefined,
      };
    });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw translatePersistenceError(err);
    }
  }
}

/** Cursor opaco: base64url de um JSON versionado. O cliente não deve (nem precisa) interpretá-lo. */
export function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: 1, before: walletVersion })).toString('base64url');
}

export function decodeCursor(cursor: string): number | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; before?: unknown };
    return parsed.v === 1 && Number.isInteger(parsed.before) && (parsed.before as number) > 0
      ? (parsed.before as number)
      : undefined;
  } catch {
    return undefined;
  }
}
