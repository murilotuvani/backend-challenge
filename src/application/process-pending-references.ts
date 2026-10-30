import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { Metrics, OutboxStore, UnitOfWork } from './ports';
import { WagerSettlement } from './wager-settlement';

export interface PendingReferenceBatchResult {
  claimed: number;
  resolved: number;
  rescheduled: number;
  expired: number;
}

/**
 * Worker agendado de PENDING_REFERENCE (README §7.1). Roda em todas as instâncias:
 *
 * 1. reserva um lote devido com FOR UPDATE SKIP LOCKED (transação curta, só linhas de transação);
 * 2. para cada uma, abre uma transação que trava PRIMEIRO a wallet e depois relê a transação —
 *    a mesma ordem de locks da submissão, então não há deadlock entre worker e API;
 * 3. aplica as mesmas regras da submissão (WagerSettlement): resolve, reagenda com backoff ou expira.
 */
export class ProcessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: OutboxStore,
    private readonly settlement: WagerSettlement,
    private readonly metrics: Metrics,
    private readonly options: { batchSize: number; leaseMs: number },
  ) {}

  async runOnce(): Promise<PendingReferenceBatchResult> {
    const claimed = await this.store.claimDuePendingReferences(this.options.batchSize, this.options.leaseMs);
    const result: PendingReferenceBatchResult = { claimed: claimed.length, resolved: 0, rescheduled: 0, expired: 0 };

    for (const candidate of claimed) {
      const outcome = await this.uow.run(async (scope): Promise<WagerTransactionStatus | 'skipped'> => {
        const wallet = await scope.lockWallet(candidate.walletId);
        const tx = await scope.findTransactionForUpdate(candidate.id);
        if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) {
          return 'skipped' as const;
        }
        const settled = await this.settlement.settle(tx, {
          scope,
          wallet,
          correlationId: tx.id,
          causationId: tx.id,
        });
        await scope.updateTransaction(tx);
        if (settled.entry) {
          await scope.insertLedgerEntry(settled.entry);
          await scope.applyLedgerEntryToWallet(settled.entry);
        }
        await scope.enqueue(WagerSettlement.toOutbox(settled));
        const settledStatus: WagerTransactionStatus = tx.status;
        return settledStatus;
      });

      if (outcome === WagerTransactionStatus.PendingReference) {
        result.rescheduled += 1;
        this.metrics.pendingReferenceRetry();
      } else if (outcome === WagerTransactionStatus.Rejected) {
        result.expired += 1;
        this.metrics.pendingReferenceExpired();
      } else if (outcome === WagerTransactionStatus.Processed) {
        result.resolved += 1;
      }
    }
    return result;
  }
}
