/**
 * Processo filho usado no teste "worker morto depois do commit e antes do ack".
 * Sobe o consumidor real; assim que o use case confirma a transação, o processo morre com
 * SIGKILL-like exit, sem chegar ao DeleteMessage.
 */
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { buildTestContainer } from './app';

const [queueName, dlqName] = process.argv.slice(2) as [string, string];
const container = await buildTestContainer({ sqs: { wagerQueueName: queueName, wagerDlqName: dlqName } });

const original = SubmitWagerTransaction.prototype.execute;
SubmitWagerTransaction.prototype.execute = async function (this: SubmitWagerTransaction, input) {
  const result = await original.call(this, input);
  console.log(JSON.stringify({ committed: result.transactionId }));
  process.exit(137);
};

await container.consumer.start();
