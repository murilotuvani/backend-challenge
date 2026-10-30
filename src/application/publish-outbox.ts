import type { Clock, EventPublisher, Metrics, OutboxStore } from './ports';

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publisher da outbox. Seguro com vários publishers concorrentes:
 *
 * - o claim usa FOR UPDATE SKIP LOCKED + lease (locked_until): dois publishers nunca pegam a mesma
 *   mensagem ao mesmo tempo, e nenhum lock fica preso durante o I/O com o broker;
 * - se o processo morrer depois de publicar e antes de marcar, o lease expira e outra instância
 *   publica de novo: entrega at-least-once, com o mesmo eventId (o consumidor deduplica);
 * - falhas de publicação reagendam com backoff exponencial.
 */
export class PublishOutbox {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly options: { batchSize: number; leaseMs: number },
  ) {}

  async runOnce(): Promise<OutboxBatchResult> {
    const batch = await this.store.claimDue(this.options.batchSize, this.options.leaseMs);
    if (batch.length === 0) {
      return { claimed: 0, published: 0, failed: 0 };
    }
    const { published, failed } = await this.publisher.publish(batch);
    if (published.length > 0) {
      await this.store.markPublished(published, this.clock.now());
      this.metrics.outboxPublished(published.length);
    }
    for (const failure of failed) {
      const message = batch.find((m) => m.id === failure.id);
      if (message) {
        message.scheduleRetry(this.clock.now());
        await this.store.scheduleRetry(message, failure.error);
      }
    }
    if (failed.length > 0) {
      this.metrics.outboxPublishFailed(failed.length);
    }
    return { claimed: batch.length, published: published.length, failed: failed.length };
  }

  async reportLag(): Promise<void> {
    const lag = await this.store.lag(this.clock.now());
    this.metrics.outboxLag(lag.oldestAgeSeconds, lag.pending);
  }
}
