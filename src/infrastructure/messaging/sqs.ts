import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { TransientInfrastructureError } from '../../application/errors';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { AppConfig } from '../config/env';

export function createSqsClient(config: AppConfig['sqs']): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Falhar rápido: o retry é decidido pela aplicação (outbox/backoff), não escondido no SDK.
    maxAttempts: 2,
  });
}

/** Resolve e memoriza URLs de fila pelo nome. */
export class QueueDirectory {
  private readonly urls = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async urlOf(queueName: string): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached) {
      return cached;
    }
    try {
      const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (!QueueUrl) {
        throw new Error(`Queue ${queueName} not found`);
      }
      this.urls.set(queueName, QueueUrl);
      return QueueUrl;
    } catch (err) {
      throw new TransientInfrastructureError(`sqs queue ${queueName} unavailable`, err);
    }
  }

  async ping(queueName: string): Promise<void> {
    const url = await this.urlOf(queueName);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  }
}

/**
 * Publica eventos de integração na fila FIFO de eventos.
 * MessageGroupId = aggregateId (ordem por wallet) e MessageDeduplicationId = eventId: uma republicação
 * dentro da janela de 5 min é descartada pelo SQS; fora dela, o consumidor deduplica pelo eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]) {
    const published: string[] = [];
    const failed: { id: string; error: string }[] = [];
    let queueUrl: string;
    try {
      queueUrl = await this.queues.urlOf(this.queueName);
    } catch (err) {
      return { published, failed: messages.map((m) => ({ id: m.id, error: String(err) })) };
    }

    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        const result = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m) => ({
              Id: m.id.replace(/-/g, ''),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
            })),
          }),
        );
        const byEntryId = new Map(chunk.map((m) => [m.id.replace(/-/g, ''), m.id]));
        for (const ok of result.Successful ?? []) {
          const id = byEntryId.get(ok.Id ?? '');
          if (id) published.push(id);
        }
        for (const ko of result.Failed ?? []) {
          const id = byEntryId.get(ko.Id ?? '');
          if (id) failed.push({ id, error: `${ko.Code}: ${ko.Message ?? ''}` });
        }
      } catch (err) {
        failed.push(...chunk.map((m) => ({ id: m.id, error: err instanceof Error ? err.message : String(err) })));
      }
    }
    return { published, failed };
  }
}
