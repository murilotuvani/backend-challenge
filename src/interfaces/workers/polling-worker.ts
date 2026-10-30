import type { Logger } from '../../infrastructure/observability/logger';
import { safeError } from '../../infrastructure/observability/safe-error';

/**
 * Laço simples de polling com parada graciosa: o ciclo em andamento sempre termina antes do stop.
 * Quando um ciclo encontra trabalho, o próximo começa imediatamente; quando não, espera o intervalo.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
    this.logger.info({ worker: this.name }, 'worker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (err) {
        this.logger.warn({ worker: this.name, err: safeError(err) }, 'worker cycle failed');
      }
      if (!busy && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
