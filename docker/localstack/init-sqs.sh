#!/bin/sh
# Executado pelo LocalStack quando o serviço fica pronto (/etc/localstack/init/ready.d).
set -eu

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

dlq_url=$(awslocal sqs create-queue --region "$REGION" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)
dlq_arn=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$dlq_url" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --region "$REGION" \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

awslocal sqs create-queue --region "$REGION" \
  --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

echo "SQS queues ready: wager-transactions.fifo, wager-transactions-dlq.fifo, wallet-events.fifo"
