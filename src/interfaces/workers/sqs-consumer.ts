import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
} from '../../application/errors';
import type { Metrics } from '../../application/ports';
import type { RecordFailedTransaction } from '../../application/record-failed-transaction';
import type { SubmitWagerCommand, SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { DomainError } from '../../domain/errors';
import type { AppConfig } from '../../infrastructure/config/env';
import type { QueueDirectory } from '../../infrastructure/messaging/sqs';
import { enrichContext, runWithContext } from '../../infrastructure/observability/context';
import type { Logger } from '../../infrastructure/observability/logger';
import { parseOrThrow, sqsDataSchema, sqsEnvelopeSchema, toCommand } from '../contracts';
import { safeError } from '../../infrastructure/observability/safe-error';

type Disposition =
  | { action: 'ack'; reason: string }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string };

/**
 * Consumidor de wager-transactions.fifo.
 *
 * - reutiliza o MESMO use case da API HTTP;
 * - deduplica pela inbox persistente (consumerName, messageId), dentro da transação financeira;
 * - ack (DeleteMessage) somente depois do commit;
 * - negócio → ack; transitório → retry com backoff (ChangeMessageVisibility); permanente → DLQ;
 * - SIGTERM: para de receber, conclui o que está em andamento e devolve a visibilidade do resto.
 */
export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private poll: AbortController | undefined;
  private readonly inFlight = new Map<string, Message>();
  private queueUrl = '';
  private dlqUrl = '';

  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly submit: SubmitWagerTransaction,
    private readonly recordFailed: RecordFailedTransaction,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly config: AppConfig['sqs'],
  ) {}

  async start(): Promise<void> {
    this.queueUrl = await this.queues.urlOf(this.config.wagerQueueName);
    this.dlqUrl = await this.queues.urlOf(this.config.wagerDlqName);
    this.running = true;
    this.loop = this.run();
    this.logger.info({ queue: this.config.wagerQueueName }, 'sqs consumer started');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.poll?.abort();
    const deadline = Date.now() + this.config.shutdownGraceMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    // O que não terminou volta imediatamente para a fila: outra instância processa, e a inbox
    // garante que nada é aplicado duas vezes caso o commit tenha acontecido.
    await Promise.all(
      [...this.inFlight.values()].map((m) => this.changeVisibility(m, 0).catch(() => undefined)),
    );
    await this.loop?.catch(() => undefined);
    this.logger.info({ released: this.inFlight.size }, 'sqs consumer stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[] = [];
      try {
        this.poll = new AbortController();
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.waitTimeSeconds,
            VisibilityTimeout: this.config.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.poll.signal },
        );
        messages = response.Messages ?? [];
      } catch (err) {
        if (!this.running) {
          break;
        }
        this.logger.warn({ err: safeError(err) }, 'sqs receive failed, backing off');
        await Bun.sleep(1_000);
        continue;
      }
      if (!this.running) {
        // recebidas durante o shutdown: devolve sem processar
        await Promise.all(messages.map((m) => this.changeVisibility(m, 0).catch(() => undefined)));
        break;
      }
      // Grupos diferentes em paralelo; dentro do mesmo grupo (wallet), em ordem.
      const groups = new Map<string, Message[]>();
      for (const m of messages) {
        const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
        groups.set(group, [...(groups.get(group) ?? []), m]);
      }
      for (const m of messages) {
        this.inFlight.set(m.MessageId ?? '', m);
      }
      await Promise.all(
        [...groups.values()].map(async (group) => {
          for (const m of group) {
            if (this.running) {
              await this.handle(m);
            } else {
              // shutdown no meio do lote: o que ainda não começou volta para a fila agora
              await this.changeVisibility(m, 0).catch(() => undefined);
              this.inFlight.delete(m.MessageId ?? '');
            }
          }
        }),
      );
    }
  }

  private async handle(message: Message): Promise<void> {
    const sqsId = message.MessageId ?? '';
    try {
      await runWithContext({ messageId: sqsId }, async () => {
        const disposition = await this.process(message);
        await this.settle(message, disposition);
      });
    } finally {
      this.inFlight.delete(sqsId);
    }
  }

  private async process(message: Message): Promise<Disposition> {
    const body = message.Body ?? '';
    let command: SubmitWagerCommand;
    let envelopeId: string;
    try {
      const envelope = parseOrThrow(sqsEnvelopeSchema, JSON.parse(body), 'message envelope');
      const data = parseOrThrow(sqsDataSchema, envelope.data, 'message data');
      envelopeId = envelope.messageId;
      command = toCommand(data, data.idempotencyKey);
    } catch (err) {
      return { action: 'dlq', reason: `invalid_payload: ${err instanceof Error ? err.message : String(err)}` };
    }

    enrichContext({
      messageId: envelopeId,
      correlationId: envelopeId,
      walletId: command.walletId,
      providerId: command.providerId,
    });

    try {
      const result = await this.submit.execute({
        command,
        source: { type: 'sqs', messageId: envelopeId, consumerName: this.config.consumerName, rawBody: body },
        correlationId: envelopeId,
      });
      enrichContext({ transactionId: result.transactionId });
      this.logger.info(
        { status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay, duplicate: result.duplicateMessage },
        'wager message processed',
      );
      return { action: 'ack', reason: result.status };
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err instanceof ExternalTransactionConflictError) {
        // Payload divergente para uma chave já usada: não é replay e reenviar não resolve.
        return { action: 'dlq', reason: err.code };
      }
      if (err instanceof NotFoundError || err instanceof DomainError) {
        return { action: 'dlq', reason: err.code };
      }
      const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
      const transient = err instanceof TransientInfrastructureError;
      this.logger.warn({ err: safeError(err), receiveCount, transient }, 'wager message failed');
      if (receiveCount >= this.config.maxReceiveCount) {
        await this.recordFailed.execute(command, envelopeId).catch((recordErr) =>
          this.logger.error({ err: safeError(recordErr) }, 'could not record FAILED transaction'),
        );
        return { action: 'dlq', reason: transient ? 'retries_exhausted' : 'unexpected_error' };
      }
      return { action: 'retry', reason: transient ? err.reason : 'unexpected_error' };
    }
  }

  private async settle(message: Message, disposition: Disposition): Promise<void> {
    try {
      if (disposition.action === 'ack') {
        await this.delete(message);
      } else if (disposition.action === 'retry') {
        const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
        const delay = Math.min(2 ** receiveCount, 300);
        this.metrics.sqsRetry();
        await this.changeVisibility(message, delay);
        this.logger.info({ delaySeconds: delay, reason: disposition.reason }, 'wager message scheduled for retry');
      } else {
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
            MessageDeduplicationId: `${message.MessageId}-dlq`,
            MessageAttributes: {
              failureReason: { DataType: 'String', StringValue: disposition.reason.slice(0, 256) },
              sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? '' },
            },
          }),
        );
        await this.delete(message);
        this.metrics.sqsDeadLettered(disposition.reason.split(':')[0] ?? 'unknown');
        this.logger.warn({ reason: disposition.reason.split(':')[0] }, 'wager message moved to DLQ');
      }
    } catch (err) {
      // Sem ack: a mensagem reaparece após o visibility timeout e a inbox impede efeito duplicado.
      this.logger.error({ err: safeError(err), action: disposition.action }, 'could not settle sqs message');
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
