/**
 * Teste de carga: `bun run test:load` (dentro do container de testes, ou de fora com APP_URLS etc.).
 *
 * Metodologia: cria WALLETS wallets e dispara operações por DURATION_S segundos com CONCURRENCY
 * workers em loop fechado (cada worker espera a resposta antes de enviar a próxima), distribuídos
 * em round-robin entre as instâncias. HOT_RATIO das operações vão para uma única "hot wallet" para
 * medir contenção. Ao final coleta métricas Prometheus das instâncias, mede o outbox lag até drenar
 * e verifica a reconciliação de todas as wallets. O relatório vai para load-results/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWallet, reconcile, tokenFor, wagerBody } from '../support/api';
import { createPool } from '../support/db';
import { env } from '../support/env';

const DURATION_S = Number.parseInt(process.env.DURATION_S ?? '30', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '48', 10);
const WALLETS = Number.parseInt(process.env.WALLETS ?? '200', 10);
const HOT_RATIO = Number.parseFloat(process.env.HOT_RATIO ?? '0.1');

interface Sample {
  ms: number;
  status: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function scrape(metric: string): Promise<number> {
  let total = 0;
  for (const url of env.appUrls) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(metric) && !line.startsWith('#')) {
        total += Number.parseFloat(line.split(' ').pop() ?? '0');
      }
    }
  }
  return total;
}

async function main(): Promise<void> {
  console.log(`setup: ${WALLETS} wallets, ${CONCURRENCY} workers, ${DURATION_S}s, hot ratio ${HOT_RATIO}`);
  const wallets: Awaited<ReturnType<typeof createWallet>>[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet('1000000.00')))));
  }
  const hot = await createWallet('1000000.00');
  const token = await tokenFor('provider-a');
  const lockConflictsBefore = await scrape('wallet_lock_conflicts_total');

  const samples: Sample[] = [];
  const deadline = Date.now() + DURATION_S * 1000;
  let seq = 0;
  const worker = async (id: number) => {
    while (Date.now() < deadline) {
      const n = seq++;
      const w = Math.random() < HOT_RATIO ? hot : wallets[n % wallets.length]!;
      const kind = n % 5 === 0 ? 'WIN' : 'BET';
      const body = wagerBody({ walletId: w.id, playerId: w.playerId, kind, amount: '1.00', externalTransactionId: `load-${n}-${w.id}` });
      const url = env.appUrls[(id + n) % env.appUrls.length]!;
      const started = performance.now();
      let status = 0;
      try {
        const res = await fetch(`${url}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'Idempotency-Key': `provider-a:${body.externalTransactionId}` },
          body: JSON.stringify(body),
        });
        status = res.status;
        await res.arrayBuffer();
      } catch {
        status = -1;
      }
      samples.push({ ms: performance.now() - started, status });
    }
  };
  const wall = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const elapsedS = (performance.now() - wall) / 1000;

  // outbox lag: tempo até a outbox drenar depois do fim da carga
  const pool = createPool(env.appDbName, 2);
  const lagStart = performance.now();
  let maxLagSeconds = 0;
  for (;;) {
    const { rows } = await pool.query(
      `select count(*)::int as n, coalesce(extract(epoch from now() - min(occurred_at)), 0)::text as age
         from outbox_messages where published_at is null`,
    );
    maxLagSeconds = Math.max(maxLagSeconds, Number.parseFloat(rows[0].age));
    if (rows[0].n === 0 || performance.now() - lagStart > 120_000) break;
    await Bun.sleep(250);
  }
  const drainSeconds = (performance.now() - lagStart) / 1000;

  let inconsistent = 0;
  for (const w of [...wallets, hot]) {
    if (!(await reconcile(w.id)).consistent) inconsistent += 1;
  }
  await pool.end();

  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.status === 201 || s.status === 200).length;
  const rejected = samples.filter((s) => s.status === 422).length;
  const errors = samples.filter((s) => s.status < 200 || s.status >= 500).length;
  const lockConflicts = (await scrape('wallet_lock_conflicts_total')) - lockConflictsBefore;

  const report = `# Resultado do teste de carga

- Data: ${new Date().toISOString()}
- Ambiente: Docker Compose local, 3 instâncias da aplicação, 1 PostgreSQL 16, LocalStack (SQS), Keycloak; tudo na mesma máquina.
- Parâmetros: ${CONCURRENCY} workers em loop fechado, ${DURATION_S}s, ${WALLETS} wallets + 1 hot wallet (${(HOT_RATIO * 100).toFixed(0)}% do tráfego), operações BET/WIN de 1.00.

| Métrica | Valor |
|---|---|
| Requisições | ${samples.length} |
| Throughput | ${(samples.length / elapsedS).toFixed(1)} req/s |
| Latência p50 | ${percentile(lat, 50).toFixed(1)} ms |
| Latência p95 | ${percentile(lat, 95).toFixed(1)} ms |
| Latência p99 | ${percentile(lat, 99).toFixed(1)} ms |
| Sucesso (200/201) | ${ok} |
| Rejeições de negócio (422) | ${rejected} |
| Taxa de erro (5xx/rede) | ${((errors / Math.max(1, samples.length)) * 100).toFixed(2)}% (${errors}) |
| Conflitos de lock (lock_timeout) | ${lockConflicts} |
| Outbox lag máximo após a carga | ${maxLagSeconds.toFixed(2)} s |
| Tempo para drenar a outbox | ${drainSeconds.toFixed(2)} s |
| Wallets inconsistentes na reconciliação | ${inconsistent} de ${wallets.length + 1} |

Observações: o gerador de carga roda na mesma máquina que o sistema, então os números são um
limite inferior e servem para comparar mudanças, não para dimensionar produção.
`;
  mkdirSync('load-results', { recursive: true });
  const file = `load-results/load-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  writeFileSync(file, report);
  console.log(report);
  console.log(`report written to ${file}`);
  if (inconsistent > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
