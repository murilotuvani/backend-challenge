import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../../application/ports';

/** Métricas Prometheus expostas em GET /metrics. Nomes estáveis, sem labels de alta cardinalidade. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions that reached a state, by kind, status and entry point',
    labelNames: ['kind', 'status', 'source'],
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager submission (including the SQL transaction)',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Requests answered from a previously stored result (duplicates detected by idempotency key)',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'SQS messages discarded by the persistent inbox (redeliveries)',
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: 'idempotency_conflicts_total',
    help: 'Same idempotency key or external id with a different payload',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Wallet row lock waits that exceeded lock_timeout',
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'sqs_retries_total',
    help: 'SQS messages returned to the queue for a retry after a transient failure',
    registers: [this.registry],
  });
  private readonly deadLettered = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'SQS messages moved to the DLQ',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'outbox_published_total',
    help: 'Integration events published from the outbox',
    registers: [this.registry],
  });
  private readonly outboxFailedTotal = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed and were rescheduled',
    registers: [this.registry],
  });
  private readonly outboxLagSeconds = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  private readonly pendingRetries = new Counter({
    name: 'pending_reference_retries_total',
    help: 'PENDING_REFERENCE transactions rescheduled because the reference is still missing',
    registers: [this.registry],
  });
  private readonly pendingExpired = new Counter({
    name: 'pending_reference_expired_total',
    help: 'PENDING_REFERENCE transactions rejected after exhausting attempts',
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliations where stored balance and ledger disagree',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionFinished(kind: string, status: string, source: string, durationSeconds: number): void {
    this.transactions.inc({ kind, status, source });
    this.latency.observe({ source }, durationSeconds);
  }
  idempotentReplay(source: string): void {
    this.replays.inc({ source });
  }
  duplicateMessage(): void {
    this.duplicates.inc();
  }
  idempotencyConflict(): void {
    this.conflicts.inc();
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  sqsRetry(): void {
    this.retries.inc();
  }
  sqsDeadLettered(reason: string): void {
    this.deadLettered.inc({ reason });
  }
  outboxPublished(count: number): void {
    this.outboxPublishedTotal.inc(count);
  }
  outboxPublishFailed(count: number): void {
    this.outboxFailedTotal.inc(count);
  }
  outboxLag(oldestAgeSeconds: number, pending: number): void {
    this.outboxLagSeconds.set(oldestAgeSeconds);
    this.outboxPending.set(pending);
  }
  pendingReferenceRetry(): void {
    this.pendingRetries.inc();
  }
  pendingReferenceExpired(): void {
    this.pendingExpired.inc();
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
