import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction';

/** Subconjunto de negócio que identifica uma operação. Header e metadados de transporte não entram. */
export interface WagerPayloadSubset {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * JSON canônico: chaves de objetos ordenadas recursivamente por code point, sem espaços,
 * `undefined` omitido. Arrays preservam a ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** payloadHash = hex(SHA-256(UTF-8(canonicalJson(subset)))). */
export function computePayloadHash(subset: WagerPayloadSubset): string {
  const normalized: WagerPayloadSubset = {
    providerId: subset.providerId,
    externalTransactionId: subset.externalTransactionId,
    playerId: subset.playerId,
    walletId: subset.walletId,
    roundId: subset.roundId,
    gameId: subset.gameId,
    kind: subset.kind,
    money: { amount: subset.money.amount, currency: subset.money.currency },
    referenceExternalTransactionId: subset.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(normalized));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
