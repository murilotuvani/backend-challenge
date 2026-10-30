import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { env } from './env';

export const sqs = new SQSClient({
  endpoint: env.sqsEndpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export async function queueUrl(name: string): Promise<string> {
  return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
}

/** Cria um par fila FIFO + DLQ exclusivo para um teste (isolado das instâncias em execução). */
export async function createQueuePair(prefix: string, maxReceiveCount: number) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const dlqName = `${prefix}-${suffix}-dlq.fifo`;
  const name = `${prefix}-${suffix}.fifo`;
  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] })))
    .Attributes!.QueueArn!;
  const url = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          VisibilityTimeout: '2',
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
        },
      }),
    )
  ).QueueUrl!;
  return {
    name,
    dlqName,
    url,
    dlqUrl,
    async destroy() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })).catch(() => undefined);
    },
  };
}

export function wagerMessage(messageId: string, data: Record<string, unknown>) {
  return JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
}

export async function sendWager(url: string, groupId: string, body: string) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: groupId,
      // dedup do SQS desligado de propósito: queremos simular redelivery real
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

export async function countMessages(url: string): Promise<number> {
  const a = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(a.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export async function receiveAll(url: string) {
  const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }));
  return r.Messages ?? [];
}

export async function purge(url: string) {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
}
