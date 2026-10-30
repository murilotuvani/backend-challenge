import { InvariantViolationError } from './errors';
import type { IntegrationEvent, SerializedIntegrationEvent } from './integration-events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 };

/** Backoff exponencial limitado: base × 2^(attempts-1), até maxDelay. */
export function backoffDelayMs(attempts: number, policy: RetryPolicy): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: publicar duas vezes gera o mesmo id e o consumidor deduplica. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as SerializedIntegrationEvent as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff) */
  scheduleRetry(now: Date, policy: RetryPolicy = DEFAULT_OUTBOX_RETRY): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts, policy));
  }
}
