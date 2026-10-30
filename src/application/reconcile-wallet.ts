import type { MoneyProps } from '../domain/money';
import { NotFoundError } from './errors';
import type { Metrics, ReadModel } from './ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** Detalhe extra: a cadeia de versões do ledger termina na versão atual da wallet. */
  versionChainConsistent: boolean;
}

export interface ReconciliationLogger {
  divergence(report: ReconciliationReport): void;
}

/**
 * Compara o saldo materializado com o reconstruído pelo ledger, lidos no mesmo snapshot.
 * Divergência nunca é corrigida silenciosamente: é logada, contada em métrica e sinalizada na resposta.
 */
export class ReconcileWallet {
  constructor(
    private readonly readModel: ReadModel,
    private readonly metrics: Metrics,
    private readonly logger: ReconciliationLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.readModel.reconciliationSnapshot(walletId);
    if (!snapshot) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    }
    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const versionChainConsistent =
      snapshot.lastEntryVersion === undefined
        ? snapshot.storedBalance.isZero()
        : snapshot.lastEntryVersion === snapshot.walletVersion &&
          snapshot.lastEntryBalanceAfter!.equals(snapshot.storedBalance);

    const report: ReconciliationReport = {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero() && versionChainConsistent,
      checkedEntries: snapshot.checkedEntries,
      versionChainConsistent,
    };
    if (!report.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.divergence(report);
    }
    return report;
  }
}
