import { FailureCode } from '../domain/failure-code';
import { WagerTransactionRejected } from '../domain/integration-events';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import { computePayloadHash } from './payload-hash';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import type { SubmitWagerCommand } from './submit-wager-transaction';

/**
 * Registra como FAILED (terminal e auditável) uma operação que esgotou as tentativas por falha de
 * infraestrutura e está indo para a DLQ. Melhor esforço: se a wallet não existe ou a chave já foi
 * usada, não há o que registrar, e a mensagem na DLQ continua sendo o registro.
 */
export class RecordFailedTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: SubmitWagerCommand, correlationId: string): Promise<string | undefined> {
    return this.uow.run(async (scope) => {
      const wallet = await scope.lockWallet(command.walletId);
      if (!wallet) {
        return undefined;
      }
      if (
        (await scope.findTransactionByIdempotencyKey(command.idempotencyKey)) ||
        (await scope.findTransactionByExternalId(command.providerId, command.externalTransactionId))
      ) {
        return undefined;
      }
      const now = this.clock.now();
      const tx = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: computePayloadHash(command),
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind as WagerTransactionKind,
        money: Money.from(command.money),
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });
      tx.fail(FailureCode.InfraPermanentFailure, now);
      await scope.insertTransaction(tx);
      await scope.enqueue([
        OutboxMessage.enqueue(
          WagerTransactionRejected.from(tx, { eventId: this.ids.next(), correlationId, occurredAt: now }),
        ),
      ]);
      return tx.id;
    });
  }
}
