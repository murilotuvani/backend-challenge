import { CurrencyMismatchError, InsufficientFundsError, ValidationError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Ids da transação OPENING e do seu lançamento, usados apenas quando o saldo inicial é positivo. */
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface WalletOpening {
  wallet: Wallet;
  /** Presente somente quando o saldo inicial é maior que zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface BalanceMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  now: Date;
}

/**
 * Aggregate root. O saldo só muda por `debit`/`credit`, que sempre devolvem o lançamento
 * correspondente, então saldo e ledger nascem juntos. `version` começa em 1 e só incrementa
 * quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): WalletOpening {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError('Initial balance cannot be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(props.initialBalance.currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.now,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError quando o débito deixaria o saldo negativo. */
  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    // A factory valida a aritmética antes de qualquer mutação do agregado.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: movement.now,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
