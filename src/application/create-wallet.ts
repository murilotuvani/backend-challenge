import { WalletBalanceChanged } from '../domain/integration-events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { UniqueConstraintRaceError, WalletAlreadyExistsError } from './errors';
import { canonicalJson, sha256Hex } from './payload-hash';
import type { Clock, IdGenerator, UnitOfWork } from './ports';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Cria a wallet e, se o saldo inicial for positivo, a transação interna OPENING com o lançamento
 * CREDIT correspondente — tudo na mesma transação SQL. Duplicidade (player, moeda) é garantida pelo
 * índice único: a corrida entre instâncias vira 409.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      now,
    });

    try {
      await this.uow.run(async (scope) => {
        await scope.insertWallet(wallet);
        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId: input.playerId,
            money: initialBalance,
            payloadHash: sha256Hex(canonicalJson({ walletId, playerId: input.playerId, initialBalance: input.initialBalance })),
            createdAt: now,
          });
          await scope.insertTransaction(opening);
          await scope.insertLedgerEntry(openingEntry);
          await scope.enqueue([
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId: input.correlationId,
                occurredAt: now,
              }),
            ),
          ]);
        }
      });
    } catch (err) {
      if (err instanceof UniqueConstraintRaceError && err.constraint === 'wallets_player_currency_uq') {
        throw new WalletAlreadyExistsError(input.playerId, initialBalance.currency);
      }
      throw err;
    }
    return wallet;
  }
}
