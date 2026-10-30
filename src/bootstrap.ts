import 'reflect-metadata';
import { type INestApplication, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { CreateWallet } from './application/create-wallet';
import { READ_MODEL } from './application/ports';
import { ProcessPendingReferences } from './application/process-pending-references';
import { PublishOutbox } from './application/publish-outbox';
import { ReconcileWallet } from './application/reconcile-wallet';
import { RecordFailedTransaction } from './application/record-failed-transaction';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerSettlement } from './application/wager-settlement';
import { JwtVerifier } from './infrastructure/auth/jwt-verifier';
import { type AppConfig, loadAppConfig } from './infrastructure/config/env';
import { QueueDirectory, SqsEventPublisher, createSqsClient } from './infrastructure/messaging/sqs';
import { logger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { type OrmOverrides, buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmOutboxStore } from './infrastructure/persistence/mikro-orm-outbox-store';
import { MikroOrmReadModel } from './infrastructure/persistence/mikro-orm-read-model';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { AuthGuard } from './interfaces/http/auth.guard';
import { OperationsController, WageringController, WalletsController } from './interfaces/http/controllers';
import { correlationMiddleware } from './interfaces/http/correlation.middleware';
import { HttpErrorFilter } from './interfaces/http/error.filter';
import {
  APP_CONFIG,
  CREATE_WALLET,
  HEALTH_CHECKS,
  type HealthChecks,
  PROMETHEUS,
  RECONCILE_WALLET,
  SUBMIT_WAGER,
} from './interfaces/http/tokens';
import { PollingWorker } from './interfaces/workers/polling-worker';
import { SqsWagerConsumer } from './interfaces/workers/sqs-consumer';

/**
 * Composition root: toda a montagem de dependências fica aqui, explícita. O domínio e a aplicação
 * não conhecem NestJS; o Nest só recebe instâncias prontas (useValue) para os controllers.
 */
export interface Container {
  config: AppConfig;
  orm: MikroORM;
  sqs: SQSClient;
  metrics: PrometheusMetrics;
  submit: SubmitWagerTransaction;
  createWallet: CreateWallet;
  reconcile: ReconcileWallet;
  readModel: MikroOrmReadModel;
  publishOutbox: PublishOutbox;
  pendingReferences: ProcessPendingReferences;
  consumer: SqsWagerConsumer;
  health: HealthChecks;
  verifier: JwtVerifier;
}

export async function buildContainer(
  config: AppConfig = loadAppConfig(),
  ormOverrides: OrmOverrides = {},
): Promise<Container> {
  const orm = await MikroORM.init(buildOrmConfig(ormOverrides));
  const metrics = new PrometheusMetrics();
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const uow = new MikroOrmUnitOfWork(orm, metrics);
  const readModel = new MikroOrmReadModel(orm);
  const store = new MikroOrmOutboxStore(orm);
  const sqs = createSqsClient(config.sqs);
  const queues = new QueueDirectory(sqs);

  const settlement = new WagerSettlement(clock, ids, {
    maxAttempts: config.pendingReference.maxAttempts,
    baseDelayMs: config.pendingReference.baseDelayMs,
    maxDelayMs: config.pendingReference.maxDelayMs,
  });
  const submit = new SubmitWagerTransaction(uow, settlement, clock, ids, metrics);
  const recordFailed = new RecordFailedTransaction(uow, clock, ids);

  return {
    config,
    orm,
    sqs,
    metrics,
    submit,
    createWallet: new CreateWallet(uow, clock, ids),
    reconcile: new ReconcileWallet(readModel, metrics, {
      divergence: (report) => logger.error({ walletId: report.walletId, checkedEntries: report.checkedEntries, difference: report.difference.amount }, 'reconciliation divergence detected'),
    }),
    readModel,
    publishOutbox: new PublishOutbox(store, new SqsEventPublisher(sqs, queues, config.sqs.eventsQueueName), clock, metrics, {
      batchSize: config.outbox.batchSize,
      leaseMs: config.outbox.leaseMs,
    }),
    pendingReferences: new ProcessPendingReferences(uow, store, settlement, metrics, {
      batchSize: config.pendingReference.batchSize,
      leaseMs: 30_000,
    }),
    consumer: new SqsWagerConsumer(sqs, queues, submit, recordFailed, metrics, logger, config.sqs),
    health: {
      database: async () => {
        await orm.em.fork().execute('select 1');
      },
      queue: () => queues.ping(config.sqs.wagerQueueName),
    },
    verifier: new JwtVerifier(config.auth),
  };
}

function httpModule(c: Container): DynamicModule {
  @Module({})
  class HttpModule {}
  return {
    module: HttpModule,
    controllers: [WalletsController, WageringController, OperationsController],
    providers: [
      { provide: APP_CONFIG, useValue: c.config },
      { provide: SUBMIT_WAGER, useValue: c.submit },
      { provide: CREATE_WALLET, useValue: c.createWallet },
      { provide: RECONCILE_WALLET, useValue: c.reconcile },
      { provide: READ_MODEL, useValue: c.readModel },
      { provide: HEALTH_CHECKS, useValue: c.health },
      { provide: PROMETHEUS, useValue: c.metrics },
      { provide: JwtVerifier, useValue: c.verifier },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: HttpErrorFilter },
    ],
  };
}

export async function createHttpApp(c: Container): Promise<INestApplication> {
  const app = await NestFactory.create(httpModule(c), { logger: ['error', 'warn'], bodyParser: true });
  app.use(correlationMiddleware);
  return app;
}

/** Sobe a instância com os papéis ligados por configuração e devolve uma função de shutdown ordenado. */
export async function startInstance(c: Container): Promise<() => Promise<void>> {
  const { roles } = c.config;
  let app: INestApplication | undefined;
  const workers: PollingWorker[] = [];

  if (roles.http) {
    app = await createHttpApp(c);
    await app.listen(c.config.httpPort, '0.0.0.0');
    logger.info({ port: c.config.httpPort }, 'http server listening');
  }
  if (roles.outboxPublisher) {
    const outbox = new PollingWorker(
      'outbox-publisher',
      c.config.outbox.pollIntervalMs,
      async () => (await c.publishOutbox.runOnce()).claimed > 0,
      logger,
    );
    const lag = new PollingWorker('outbox-lag', 5_000, async () => {
      await c.publishOutbox.reportLag();
      return false;
    }, logger);
    workers.push(outbox, lag);
  }
  if (roles.pendingReferenceWorker) {
    workers.push(
      new PollingWorker(
        'pending-reference',
        c.config.pendingReference.pollIntervalMs,
        async () => (await c.pendingReferences.runOnce()).claimed > 0,
        logger,
      ),
    );
  }
  for (const w of workers) {
    w.start();
  }
  if (roles.sqsConsumer) {
    await c.consumer.start();
  }

  return async () => {
    logger.info('shutting down');
    // 1) para de aceitar trabalho novo; 2) conclui o que está em andamento; 3) fecha conexões.
    await c.consumer.stop();
    await Promise.all(workers.map((w) => w.stop()));
    await app?.close();
    await c.orm.close(true);
    c.sqs.destroy();
    logger.info('shutdown complete');
  };
}
