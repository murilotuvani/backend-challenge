# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
recebidas por HTTP e por SQS, correto com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- Especificação original do desafio: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

**Stack:** Bun 1.3 · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 16 · SQS (LocalStack) · Keycloak 26 · Docker Compose.

---

## Pré-requisito

Somente **Docker** (com Docker Compose v2). Nada é instalado na máquina: aplicação, migrations, testes e teste de carga rodam em containers,
todos na rede Docker `jungle`.

## Subir o ambiente

```bash
docker compose up -d --build
```

Isso sobe, em ordem:

| Serviço | Papel | Porta no host |
|---|---|---|
| `postgres` | PostgreSQL 16. O script `docker/postgres/01-init.sql` cria o usuário `chimp`, o banco `jungle` (e `keycloak`, `jungle_test`) | 5432 |
| `localstack` | SQS. `docker/localstack/init-sqs.sh` cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wallet-events.fifo` | 4566 |
| `keycloak` | Identity Provider, realm `jungle` importado de `docker/keycloak/realm-jungle.json` | 8080 |
| `migrate` | Job que aplica as migrations e termina | — |
| `app-1`, `app-2`, `app-3` | Três instâncias idênticas da aplicação (HTTP + consumidor SQS + publisher da outbox + worker de referências) | 3001, 3002, 3003 |

Acompanhe com `docker compose ps` (as instâncias ficam `healthy` quando PostgreSQL e SQS estão alcançáveis).

> O script de init do PostgreSQL só roda na **primeira** criação do volume. Se você já tinha um volume `pgdata` antigo, recrie com
> `docker compose down -v && docker compose up -d --build`.

## Testes

```bash
docker compose run --rm test                         # tudo: unitários, integração e concorrência (≈ 1–2 min)
docker compose run --rm test bun run test:unit       # só unitários (sem infraestrutura)
docker compose run --rm test bun run test:integration
docker compose run --rm test bun run test:concurrency
docker compose run --rm test bun run test:multi-currency # um jogador com quatro wallets (BRL, USD, EUR, CHF)
docker compose run --rm test bun run test:load       # teste de carga (diferencial), relatório em load-results/
```

O container `test` usa a mesma imagem da aplicação, fala com as instâncias pela rede `jungle` e tem o socket do Docker montado para
os testes de falha poderem matar (`SIGKILL`) e reiniciar instâncias reais. **Nenhum teste substitui PostgreSQL ou SQS por mocks.**

| Suíte | O que cobre |
|---|---|
| `test/unit` | `Money` (escala, entradas inválidas, aritmética exata), invariantes da `Wallet`, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, hash canônico e idempotency key com payload divergente, outbox/inbox |
| `test/integration/schema-constraints` | Migrations reversíveis e cada constraint/trigger do schema, escrevendo SQL direto no banco (saldo negativo, ledger imutável, saldo sem lançamento, reversão dupla...) |
| `test/integration/transactional-flows` | Atomicidade wallet + ledger + inbox + outbox (falha injetada em cada etapa), dois publishers na mesma outbox, lease após crash do publisher, retry do broker, expiração de `PENDING_REFERENCE`, workers concorrentes, recuperação após reinício, lock timeout → erro transitório |
| `test/integration/sqs-consumer` | Inbox e redelivery, rejeição de negócio com ack, DLQ para erro permanente, retry com backoff, tentativas esgotadas → DLQ + `FAILED`, **worker morto depois do commit e antes do ack** (processo filho), SIGTERM |
| `test/concurrency/wallet-races` | Mesma aposta 50× em paralelo, 2 apostas de 80.00 sobre 100.00, hot wallet com 150 apostas, wallets distintas em paralelo, REFUND × ROLLBACK simultâneos, reversão antes da referência — tudo distribuído entre as 3 instâncias |
| `test/concurrency/restart-recovery` | `SIGKILL` e restart de instâncias durante carga HTTP + SQS; prova que cada operação confirmada existe uma vez, a fila drena, a outbox é publicada e saldo == ledger |
| `test/multi-currency` | Suíte separada: um jogador com quatro wallets (BRL, USD, EUR, CHF). No domínio, `CurrencyMismatchError` em `debit`/`credit`/`canDebit` e em `Money` para as 12 combinações de moeda; caixa-preta, unicidade (jogador, moeda) com 409, criação simultânea, isolamento entre as wallets e rejeição 422 `CURRENCY_MISMATCH` (com replay) sem alterar saldo nem ledger |

Todas as suítes que tocam o banco terminam verificando a invariante `wallet.balance == saldo reconstruído pelo ledger` para todas as wallets.

## Usando a API

Todas as rotas exigem um token do Keycloak, exceto `/health/*` e `/metrics`. Clients do realm `jungle` (client credentials):

| Client | Secret | Papel |
|---|---|---|
| `provider-a` | `provider-a-secret` | `provider` (só age como `provider-a`) |
| `provider-b` | `provider-b-secret` | `provider` (só age como `provider-b`) |
| `back-office` | `back-office-secret` | `wallet-admin` (wallets, ledger, reconciliação, consultas) |

```bash
token() { curl -s -X POST localhost:8080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=$1 -d client_secret=$1-secret | sed -E 's/.*"access_token":"([^"]+)".*/\1/'; }
ADMIN=$(token back-office); PROVIDER=$(token provider-a)

# criar wallet (saldo inicial gera a transação interna OPENING + lançamento CREDIT)
curl -s -X POST localhost:3001/wallets -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# submeter uma aposta (troque WALLET_ID); repetir a mesma requisição devolve idempotentReplay: true
curl -s -X POST localhost:3002/wagering/transactions -H "authorization: Bearer $PROVIDER" \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

curl -s localhost:3003/wallets/WALLET_ID -H "authorization: Bearer $ADMIN"
curl -s "localhost:3001/wallets/WALLET_ID/ledger?limit=50" -H "authorization: Bearer $ADMIN"
curl -s -X POST localhost:3001/wallets/WALLET_ID/reconciliation -H "authorization: Bearer $ADMIN"
curl -s localhost:3001/health/ready
curl -s localhost:3001/metrics
```

Rotas: `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?cursor=&limit=`, `POST /wallets/:walletId/reconciliation`,
`POST /wagering/transactions`, `GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `GET /health/live`, `GET /health/ready`, `GET /metrics`.

Status HTTP (detalhes em ARCHITECTURE §8): `201` processada · `200` replay · `202` aguardando referência · `400` payload inválido ·
`401/403` autenticação · `404` inexistente · `409` conflito de idempotência / wallet duplicada · `422` rejeição de negócio (com `failureCode`) ·
`503` falha transitória (seguro reenviar com a mesma `Idempotency-Key`).

### Enviando pela fila

```bash
docker compose exec localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_ID --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{
    "providerId":"provider-a","externalTransactionId":"transaction-456","idempotencyKey":"provider-a:transaction-456",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`,
`WagerTransactionPendingReference`) são publicados pela outbox em `wallet-events.fifo`.

## Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` propagados por `AsyncLocalStorage`;
  valores monetários e payloads não são logados. `docker compose logs -f app-1`.
- Métricas Prometheus em `/metrics`: `wager_transactions_total{kind,status,source}`, `wager_processing_duration_seconds`,
  `idempotent_replays_total`, `inbox_duplicates_total`, `idempotency_conflicts_total`, `wallet_lock_conflicts_total`, `sqs_retries_total`,
  `sqs_dead_lettered_total{reason}`, `outbox_lag_seconds`, `outbox_pending`, `outbox_published_total`, `pending_reference_*`,
  `reconciliation_divergences_total`.
- `GET /health/live` (processo) e `GET /health/ready` (PostgreSQL + SQS).

## Configuração

Variáveis principais (valores padrão em `src/infrastructure/config/env.ts`):

| Variável | Padrão | Descrição |
|---|---|---|
| `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `postgres` / `jungle` / `chimp` / — | Conexão |
| `DB_POOL_MAX` | `10` | Conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock da wallet (vira 503 / retry) |
| `ROLE_HTTP`, `ROLE_SQS_CONSUMER`, `ROLE_OUTBOX_PUBLISHER`, `ROLE_PENDING_REFERENCE_WORKER` | `true` | Papéis da instância |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Tentativas antes da DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | Tentativas de resolver a referência antes de `REFERENCE_NOT_FOUND` |
| `AUTH_ENABLED` | `true` | Validação de JWT do Keycloak |
| `REGISTRY` | `docker.io` | Registry das imagens base (ex.: `mirror.gcr.io` se o Docker Hub limitar downloads) |

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, erros (sem NestJS/ORM)
  application/     use cases e portas (SubmitWagerTransaction, CreateWallet, ReconcileWallet, PublishOutbox, ...)
  infrastructure/  MikroORM (EntitySchema, mappers, migrations), SQS, Keycloak/JWT, logs, métricas, config
  interfaces/      controllers HTTP, contratos (zod), consumidor SQS, workers
  bootstrap.ts     composition root
test/              unit, integration, concurrency, load, support
docker/            init do PostgreSQL, filas do LocalStack, realm do Keycloak
```

## Comandos úteis

```bash
docker compose run --rm test bun run typecheck          # tsc --noEmit em modo estrito
docker compose run --rm migrate bun run migrate:down    # reverte a última migration
docker compose down -v                                  # derruba tudo e apaga os volumes
```
