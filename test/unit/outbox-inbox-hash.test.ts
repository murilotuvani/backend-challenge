import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash, type WagerPayloadSubset } from '../../src/application/payload-hash';
import { InboxMessage } from '../../src/domain/inbox-message';
import { WalletBalanceChanged } from '../../src/domain/integration-events';
import { Money } from '../../src/domain/money';
import { OutboxMessage, backoffDelayMs } from '../../src/domain/outbox-message';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const now = new Date('2026-10-30T12:00:00Z');

describe('canonicalJson / payloadHash', () => {
  test('ordena chaves recursivamente e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: undefined, b: [2, 1] } })).toBe('{"a":{"b":[2,1],"d":"x"},"b":1}');
  });

  const payload: WagerPayloadSubset = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'p1',
    walletId: 'w1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('hash independe da ordem das chaves', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayloadSubset;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
    expect(computePayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('idempotency key com payload divergente gera hash diferente', () => {
    expect(computePayloadHash({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      computePayloadHash(payload),
    );
    expect(computePayloadHash({ ...payload, roundId: 'other' })).not.toBe(computePayloadHash(payload));
  });

  test('campos extras de transporte não entram no hash', () => {
    const withExtras = { ...payload, idempotencyKey: 'k', messageId: 'm' } as unknown as WagerPayloadSubset;
    expect(computePayloadHash(withExtras)).toBe(computePayloadHash(payload));
  });
});

describe('OutboxMessage', () => {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    openingTransactionId: 't0',
    openingEntryId: 'e0',
    now,
  });
  const entry = wallet.credit({
    entryId: 'e1',
    transactionId: 't1',
    money: Money.from({ amount: '1.00', currency: 'BRL' }),
    now,
  });
  const event = WalletBalanceChanged.from(wallet, entry, { eventId: 'ev-1', correlationId: 'c-1', occurredAt: now });

  test('envelope carrega eventType e version do tipo, e MoneyProps em string', () => {
    const json = event.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(now.toISOString());
    expect(json.data.balanceAfter).toEqual({ amount: '11.00', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('enqueue usa o eventId como id e nasce pendente e devido', () => {
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe('ev-1');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(now)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial limitado', () => {
    const msg = OutboxMessage.enqueue(event);
    msg.scheduleRetry(now);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(1_000);
    msg.scheduleRetry(now);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(2_000);
    expect(msg.isDue(now)).toBe(false);
    expect(backoffDelayMs(50, { baseDelayMs: 1_000, maxDelayMs: 60_000 })).toBe(60_000);
  });

  test('markPublished é único', () => {
    const msg = OutboxMessage.enqueue(event);
    msg.markPublished(now);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(now)).toThrow();
  });
});

describe('InboxMessage', () => {
  test('markProcessed só uma vez', () => {
    const msg = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: now });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(now);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(now)).toThrow();
  });
});
