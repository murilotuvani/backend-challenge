/**
 * Taxonomia estável de falhas, legível por máquina. Ver ARCHITECTURE.md §7.2.
 * Os valores são contrato público: nunca renomeie, apenas adicione.
 */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceInvalidKind: 'REFERENCE_INVALID_KIND',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  InfraPermanentFailure: 'INFRA_PERMANENT_FAILURE',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

const ALL = new Set<string>(Object.values(FailureCode));

export function isFailureCode(value: string): value is FailureCode {
  return ALL.has(value);
}
