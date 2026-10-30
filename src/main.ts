import { buildContainer, startInstance } from './bootstrap';
import { logger } from './infrastructure/observability/logger';
import { safeError } from './infrastructure/observability/safe-error';

async function main(): Promise<void> {
  const container = await buildContainer();
  const shutdown = await startInstance(container);

  let stopping = false;
  const onSignal = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, 'signal received');
    shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err: safeError(err) }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: safeError(err) }, 'failed to start');
  process.exit(1);
});
