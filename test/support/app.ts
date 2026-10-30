import { type Container, buildContainer } from '../../src/bootstrap';
import { type AppConfig, loadAppConfig } from '../../src/infrastructure/config/env';
import { env } from './env';

/** Monta a aplicação real (mesmo composition root) apontando para o banco de testes. */
export async function buildTestContainer(overrides: {
  sqs?: Partial<AppConfig['sqs']>;
  pendingReference?: Partial<AppConfig['pendingReference']>;
  outbox?: Partial<AppConfig['outbox']>;
  poolMax?: number;
} = {}): Promise<Container> {
  const base = loadAppConfig();
  const config: AppConfig = {
    ...base,
    auth: { ...base.auth, enabled: false },
    sqs: { ...base.sqs, endpoint: env.sqsEndpoint, waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, ...overrides.sqs },
    pendingReference: { ...base.pendingReference, ...overrides.pendingReference },
    outbox: { ...base.outbox, ...overrides.outbox },
  };
  return buildContainer(config, { dbName: env.testDbName, poolMax: overrides.poolMax ?? 20 });
}

export async function closeContainer(c: Container): Promise<void> {
  await c.consumer.stop().catch(() => undefined);
  await c.orm.close(true);
  c.sqs.destroy();
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });
