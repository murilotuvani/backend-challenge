import { CurrencyMismatchError, ValidationError } from './errors';

/** DTO de contrato: valor decimal como string com exatamente 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Até 18 dígitos inteiros, compatível com NUMERIC(20,2) no banco. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const SIGNED_AMOUNT_PATTERN = /^-?(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável e exato.
 *
 * Internamente guarda unidades menores (centavos) em `bigint`: a escala é fixa em 2 e só existem
 * soma e subtração, então não há arredondamento possível e nenhum `number` participa do cálculo.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada de contrato: rejeita negativos, notação científica, NaN, Infinity e escala diferente de 2. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new ValidationError('Money must be an object with amount and currency');
    }
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new ValidationError(
        `Invalid amount ${JSON.stringify(props.amount)}: expected a non-negative decimal string with exactly ${SCALE} decimal places`,
      );
    }
    return new Money(Money.toMinor(props.amount), currency);
  }

  /** Reidratação a partir da persistência ou de cálculos internos (aceita sinal). */
  static rehydrate(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !SIGNED_AMOUNT_PATTERN.test(amount)) {
      throw new ValidationError(`Invalid persisted amount ${JSON.stringify(amount)}`);
    }
    return new Money(Money.toMinor(amount), Money.parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal com 2 casas, sem moeda: "25.00", "-5.10". */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const units = abs / FACTOR;
    const cents = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new ValidationError(`Invalid currency ${JSON.stringify(currency)}: expected ISO-4217 code`);
    }
    return currency;
  }

  private static toMinor(amount: string): bigint {
    const negative = amount.startsWith('-');
    const [units, cents] = (negative ? amount.slice(1) : amount).split('.') as [string, string];
    const value = BigInt(units) * FACTOR + BigInt(cents);
    return negative ? -value : value;
  }
}
