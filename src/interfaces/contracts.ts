import { z } from 'zod';
import type { SubmitWagerCommand } from '../application/submit-wager-transaction';
import { ValidationError } from '../domain/errors';
import { Money } from '../domain/money';
import { EXTERNAL_KINDS } from '../domain/wager-transaction';

/**
 * Contratos de entrada (HTTP e SQS) validados na borda. O formato do Money é validado pelo próprio
 * domínio (Money.from), então as duas entradas rejeitam exatamente as mesmas strings.
 */

const moneySchema = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const money = Money.from(value);
      if (money.isNegative()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount must not be negative' });
      }
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : 'invalid money' });
    }
  });

const id = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();

export const wagerPayloadSchema = z
  .object({
    providerId: id,
    externalTransactionId: id,
    playerId: uuid,
    walletId: uuid,
    roundId: id,
    gameId: id,
    kind: z.enum(EXTERNAL_KINDS.map(String) as [string, ...string[]], {
      errorMap: () => ({ message: `kind must be one of ${EXTERNAL_KINDS.join(', ')} (OPENING is internal)` }),
    }),
    money: moneySchema,
    referenceExternalTransactionId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === 'REFUND' || value.kind === 'ROLLBACK') && !value.referenceExternalTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceExternalTransactionId'],
        message: `${value.kind} requires referenceExternalTransactionId`,
      });
    }
  });

export const sqsEnvelopeSchema = z.object({
  messageId: id,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.unknown(),
});

export const sqsDataSchema = wagerPayloadSchema.innerType().extend({ idempotencyKey: id }).strict();

export const createWalletSchema = z
  .object({
    playerId: uuid,
    initialBalance: moneySchema,
  })
  .strict();

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      `Invalid ${what}`,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}

export function toCommand(payload: z.infer<typeof wagerPayloadSchema>, idempotencyKey: string): SubmitWagerCommand {
  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind as SubmitWagerCommand['kind'],
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
    idempotencyKey,
  };
}
