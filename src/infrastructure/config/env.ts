/** Leitura centralizada e tipada das variáveis de ambiente. Falha cedo se algo obrigatório faltar. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got ${raw}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  return optional(name, String(fallback)).toLowerCase() === 'true';
}

export interface DatabaseConfig {
  host: string;
  port: number;
  dbName: string;
  user: string;
  password: string;
  poolMax: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export function loadDatabaseConfig(): DatabaseConfig {
  return {
    host: optional('DB_HOST', 'postgres'),
    port: int('DB_PORT', 5432),
    dbName: optional('DB_NAME', 'jungle'),
    user: optional('DB_USER', 'chimp'),
    password: required('DB_PASSWORD'),
    poolMax: int('DB_POOL_MAX', 10),
    lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 5_000),
    statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 15_000),
  };
}

export interface AppConfig {
  instanceId: string;
  httpPort: number;
  roles: {
    http: boolean;
    sqsConsumer: boolean;
    outboxPublisher: boolean;
    pendingReferenceWorker: boolean;
  };
  sqs: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    consumerName: string;
    maxReceiveCount: number;
    concurrency: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    shutdownGraceMs: number;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
  };
  pendingReference: {
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  auth: {
    enabled: boolean;
    issuer: string;
    jwksUri: string;
    adminRole: string;
  };
  logLevel: string;
}

export function loadAppConfig(): AppConfig {
  return {
    instanceId: optional('INSTANCE_ID', process.env.HOSTNAME ?? 'local'),
    httpPort: int('HTTP_PORT', 3000),
    roles: {
      http: bool('ROLE_HTTP', true),
      sqsConsumer: bool('ROLE_SQS_CONSUMER', true),
      outboxPublisher: bool('ROLE_OUTBOX_PUBLISHER', true),
      pendingReferenceWorker: bool('ROLE_PENDING_REFERENCE_WORKER', true),
    },
    sqs: {
      endpoint: optional('SQS_ENDPOINT', 'http://localstack:4566'),
      region: optional('AWS_REGION', 'us-east-1'),
      accessKeyId: optional('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: optional('AWS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueName: optional('SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      wagerDlqName: optional('SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueueName: optional('SQS_EVENTS_QUEUE', 'wallet-events.fifo'),
      consumerName: optional('SQS_CONSUMER_NAME', 'wager-transactions-consumer'),
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      concurrency: int('SQS_CONCURRENCY', 10),
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 20),
      visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 20_000),
    },
    outbox: {
      pollIntervalMs: int('OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: int('OUTBOX_BATCH_SIZE', 50),
      leaseMs: int('OUTBOX_LEASE_MS', 30_000),
    },
    pendingReference: {
      pollIntervalMs: int('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
      batchSize: int('PENDING_REFERENCE_BATCH_SIZE', 50),
      maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
      baseDelayMs: int('PENDING_REFERENCE_BASE_DELAY_MS', 1_000),
      maxDelayMs: int('PENDING_REFERENCE_MAX_DELAY_MS', 300_000),
    },
    auth: {
      enabled: bool('AUTH_ENABLED', true),
      issuer: optional('AUTH_ISSUER', 'http://keycloak:8080/realms/jungle'),
      jwksUri: optional('AUTH_JWKS_URI', 'http://keycloak:8080/realms/jungle/protocol/openid-connect/certs'),
      adminRole: optional('AUTH_ADMIN_ROLE', 'wallet-admin'),
    },
    logLevel: optional('LOG_LEVEL', 'info'),
  };
}
