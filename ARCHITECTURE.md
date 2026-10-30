# Arquitetura — Distributed Wagering Processor

> Decisões técnicas, trade-offs e limitações. Cada decisão traz o **porquê**.
> Setup e comandos estão no [README](README.md); a especificação original está em [docs/CHALLENGE.md](docs/CHALLENGE.md).

---

## 1. Visão geral

Um único serviço NestJS (Bun 1.x, TypeScript estrito), empacotado em uma imagem e executado em **3 réplicas**.
Cada réplica tem os mesmos papéis, ligados por variável de ambiente:

| Papel | O que faz |
|---|---|
| `http` | API REST (wallets, transações, reconciliação, health, métricas) |
| `sqs-consumer` | consome `wager-transactions.fifo` e chama o **mesmo use case** do HTTP |
| `outbox-publisher` | publica eventos pendentes da outbox |
| `pending-reference-worker` | reprocessa transações `PENDING_REFERENCE` com backoff |

Como **todas** as réplicas rodam todos os papéis, a correção nunca depende de existir um único worker: a coordenação acontece no PostgreSQL (row locks e `SKIP LOCKED`).

### Camadas (hexagonal / ports & adapters)

```
src/
  domain/          # Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox, Outbox, eventos, erros
                   # zero dependência de NestJS ou MikroORM
  application/     # use cases (SubmitWagerTransaction, CreateWallet, Reconcile...) e portas
                   # (UnitOfWork/TransactionScope, ReadModel, OutboxStore, EventPublisher, Clock, IdGenerator, Metrics)
  infrastructure/  # MikroORM (EntitySchema + mappers), SQS, Keycloak/JWT, métricas, logs
  interfaces/      # controllers HTTP, consumidor SQS, workers agendados
```

O domínio é puro: construtores privados, factories `create`/`from`/`rehydrate`, nenhum decorator. A persistência usa
`EntitySchema` do MikroORM sobre **records de persistência** e mappers explícitos `record ↔ domínio`. Isso mantém o domínio
livre do ORM (exigência 6.1) e evita depender de `emitDecoratorMetadata` no Bun.

---

## 2. Stack e justificativas

| Item | Escolha | Por quê |
|---|---|---|
| ORM | **MikroORM** (driver PostgreSQL) | Preferencial no desafio. `em.transactional()` e `LockMode.PESSIMISTIC_WRITE` expressam exatamente a estratégia abaixo |
| Migrations | MikroORM Migrator, com `up` e `down` escritos à mão em SQL | Constraints, triggers e índices parciais são parte da avaliação, então ficam explícitos em SQL e não gerados |
| Fila | LocalStack (SQS) | Mais documentado e estável que o MiniStack |
| IdP | **Keycloak** | Sua escolha. OIDC completo, realm importado de JSON para ser reproduzível |
| Logs | `pino` (JSON) + `AsyncLocalStorage` para o contexto | Rápido, estruturado e funciona no Bun |
| Métricas | `prom-client`, exposto em `GET /metrics` | Padrão de mercado, fácil de demonstrar |
| IDs | UUIDv7 | Ordenáveis no tempo, o que deixa o cursor do ledger estável e os índices B-tree eficientes |
| Hash | SHA-256 (`node:crypto`, suportado pelo Bun) | |

---

## 3. Money

- Representação interna em **`bigint` de unidades menores** (centavos), com escala fixa de 2.
  O README sugere `Decimal`, mas como a escala é fixa e não há multiplicação nem divisão, `bigint` é exato, não precisa de biblioteca e
  torna impossível vazar `number`. 
- Parser por regex estrita: `^(0|[1-9]\d*)\.\d{2}$`. Rejeita `NaN`, `Infinity`, notação científica, string vazia, sinal, `"25"` e `"25.0"`.
  **Exigimos exatamente 2 casas na entrada** (é a interpretação mais segura de "escala fixa"). 
- Valores negativos só existem como resultado interno (`negate`), nunca em contratos de entrada.
- Moeda: ISO-4217 com 3 letras maiúsculas. Operações entre moedas diferentes lançam `CurrencyMismatchError`.
- Persistência: `NUMERIC(20,2)` + `CHAR(3)` em colunas separadas. O driver `pg` devolve `NUMERIC` como string, que vai direto para
  `Money.from`. Nenhum `number` existe no caminho.

---

## 4. Schema e garantias no banco

As invariantes valem **mesmo que o código da aplicação tenha um bug**.

### `wallets`
- `UNIQUE (player_id, currency)` garante uma wallet por player e moeda.
- `CHECK (balance >= 0)` é a última barreira contra saldo negativo.
- `CHECK (version >= 1)`.

### `wager_transactions`
- `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE (idempotency_key)`.
- `CHECK (amount > 0)`, `CHECK` de `kind` e de `status` (ou enums nativos do PostgreSQL).
- `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)`.
- `CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)` e `CHECK (status <> 'REJECTED' OR failure_code IS NOT NULL)`.
- **Reverter uma única vez:** índice único parcial `ON (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
- `resulting_balance_amount` + `resulting_balance_currency` (snapshot do saldo no processamento), usado para responder o replay com o saldo **original** (regra 7.7). A moeda fica separada porque, num `CURRENCY_MISMATCH`, o saldo observado está na moeda da wallet e não na da transação.
- FK composta `(reference_transaction_id, wallet_id) → (id, wallet_id)`: o banco garante que a referência pertence à **mesma wallet**.
- Um trigger impede transicionar a partir de status terminal (`PROCESSED`, `REJECTED`, `FAILED`), voltar para `PENDING`, alterar colunas de identidade (valor, kind, wallet, chaves...) e apagar transações.

### `wallet_ledger_entries`
- `UNIQUE (transaction_id, wallet_id)` garante no máximo um lançamento por transação e wallet.
- `CHECK (amount > 0 AND balance_before >= 0 AND balance_after >= 0)`.
- `CHECK ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount))`.
- **Imutabilidade:** trigger `BEFORE UPDATE OR DELETE` que lança exceção. Também `BEFORE TRUNCATE`.
- `wallet_version`: versão da wallet produzida pelo lançamento, com `UNIQUE (wallet_id, wallet_version)`. O ledger vira uma **cadeia** 1:1 com as mudanças de saldo (versão 1 = abertura, se houver saldo inicial). O cursor da paginação é essa versão (estável mesmo com relógios diferentes entre instâncias), codificada em base64url para ser opaca.

### Consistência entre saldo e ledger no schema
Trigger **`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`** em `wallets`: no commit, se o saldo mudou, exige um lançamento
com `wallet_version` igual à nova versão, cujo `balance_after` seja igual ao novo saldo e cujo `balance_before` seja igual ao antigo. Isso torna "saldo mudou sem ledger"
impossível no banco, e não só no código. No sentido inverso, um trigger deferred em `wallet_ledger_entries` recusa lançamento cuja versão a wallet nunca atingiu,
e um trigger `BEFORE UPDATE` em `wallets` exige que `version` mude junto com o saldo, de 1 em 1. Os testes de `test/integration/schema-constraints.test.ts`
escrevem SQL direto no banco, contornando a aplicação, e comprovam cada recusa.

### `inbox_messages`
- `PRIMARY KEY (consumer_name, message_id)`, `payload_hash`, `received_at`, `processed_at`.

### `outbox_messages`
- `id`, `aggregate_id`, `event_type`, `payload JSONB`, `occurred_at`, `attempts`, `next_attempt_at`, `locked_until`, `published_at`.
- Índice parcial `ON (next_attempt_at) WHERE published_at IS NULL`.

### Papéis
A aplicação conecta como `chimp`. O ideal seria separar o owner das migrations do usuário de runtime, sem `UPDATE`/`DELETE` no ledger.
Vamos documentar como melhoria, e o trigger cobre a garantia.

---

## 5. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet), dentro de
`em.transactional()`, isolamento `READ COMMITTED`.

Fluxo de `SubmitWagerTransaction`, todo em **uma transação SQL**:

1. `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` serializa todas as operações daquela wallet, e só dela.
2. Busca a transação existente por `idempotency_key`:
   - existe e o hash é igual → **replay** (devolve o resultado gravado);
   - existe e o hash é diferente → **conflito**.
3. Se for entrada SQS, `INSERT` na inbox (`ON CONFLICT DO NOTHING`). Se não inseriu, é redelivery, então ack sem efeito.
4. Resolve a referência (se houver) e aplica as regras de domínio em memória (`wallet.debit/credit` gera o `WalletLedgerEntry`).
5. Para cada lançamento: `INSERT` do lançamento e `UPDATE wallets SET balance = $after, version = $v WHERE id = $1 AND version = $v - 1` (a checagem de versão é uma defesa extra; 0 linhas afetadas aborta a transação).
6. `INSERT` da transação, do lançamento e dos eventos na outbox.
7. `COMMIT`. Só depois disso a resposta HTTP é enviada ou a mensagem SQS recebe ack.

**Por que pessimista e não otimista:** o caso crítico é a *hot wallet* (50 apostas iguais em paralelo, duas apostas disputando o saldo).
Com locking otimista, cada perdedor faz retry e o custo cresce com a contenção. Com o row lock, os concorrentes esperam na fila do
PostgreSQL e cada um enxerga o estado já confirmado do anterior. O lock é **por wallet** (nunca global, restrição 5.6), então
wallets diferentes rodam em paralelo. Cada transação trava **uma** única wallet, então não existe ciclo e não há deadlock.
`lock_timeout` (ex.: 5s) transforma espera longa em erro transitório (HTTP 503 ou retry SQS) e incrementa a métrica `lock_conflicts`.

**Corrida de idempotência entre wallets diferentes** (mesma key com outro `walletId`): o `UNIQUE (idempotency_key)` estoura com
`23505`. Capturamos, relemos a transação existente e respondemos como conflito. O banco é a fonte da verdade, nunca um cache.

**SQS FIFO** com `MessageGroupId = walletId` dá ordenação por wallet como **otimização**. A correção continua garantida pelo banco.

---

## 6. Idempotência

- HTTP: o header `Idempotency-Key` é obrigatório (400 se faltar). Na fila: `data.idempotencyKey`.
- **payloadHash** = `sha256(canonicalJson(subset))` em hex. O `subset` contém `providerId`, `externalTransactionId`, `playerId`, `walletId`,
  `roundId`, `gameId`, `kind`, `money.amount` (normalizado por `Money`), `money.currency` e `referenceExternalTransactionId`
  (omitido quando ausente). JSON canônico: chaves ordenadas recursivamente, sem espaços, UTF-8. O header e `messageId`/`occurredAt` não entram.
- Replay devolve `status`, `failureCode`, `transactionId` e o **saldo gravado no momento**, com `idempotentReplay: true`.
- Dedup de transporte (inbox por `messageId`) e dedup de negócio (idempotency key) são camadas diferentes e as duas existem: duas mensagens
  diferentes com a mesma key viram replay. A mesma mensagem entregue de novo é descartada pela inbox. O `payload_hash` da inbox é o SHA-256 do corpo bruto da mensagem.
- O mesmo `(providerId, externalTransactionId)` com **outra** idempotency key também é conflito (`409 EXTERNAL_TRANSACTION_CONFLICT`).
- Corrida entre instâncias com a mesma key em wallets diferentes: o `23505` é traduzido para `UniqueConstraintRaceError` e o use case roda de novo **uma** vez, agora enxergando o estado confirmado.

---

## 7. Regras de negócio e interpretações

| Kind | Efeito | Referência |
|---|---|---|
| `BET` | débito; `INSUFFICIENT_FUNDS` se faltar saldo | não |
| `WIN` | crédito | opcional (a `BET` da rodada); se informada e ausente → `PENDING_REFERENCE` |
| `LOSS` | nenhum, sem ledger, publica `WagerTransactionProcessed` | opcional |
| `REFUND` | crédito, só sobre `BET` `PROCESSED` | obrigatória |
| `ROLLBACK` | inverso da referência (`BET` → crédito; `WIN`/`REFUND` → débito) | obrigatória |

Interpretações a documentar:

1. **Uma transação só pode ser revertida uma vez, por qualquer tipo.** O README fala em "uma vez pelo mesmo tipo", mas permitir
   `REFUND` **e** `ROLLBACK` da mesma `BET` daria crédito duplo. Optamos pela regra mais restrita.
2. Rollback de rollback não é permitido (a especificação só lista `BET`, `WIN` e `REFUND`).
3. Reverter um `ROLLBACK` que deixaria o saldo negativo → `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS` (diferente de `INSUFFICIENT_FUNDS`).
4. A referência precisa ter o mesmo provider, player, wallet, moeda e rodada. Caso contrário → `REFERENCE_MISMATCH`.
5. Uma referência que existe mas ainda está `PENDING`/`PENDING_REFERENCE` é tratada como ausente (continua aguardando).
6. Wallet inexistente: não há agregado para persistir, então a resposta é 404 `WALLET_NOT_FOUND`, sem registro.
   O `playerId` divergente da wallet → `REJECTED` com `WALLET_PLAYER_MISMATCH`.
7. `OPENING` submetido externamente → 400 na validação do contrato.
8. Referência que existe mas terminou `REJECTED` ou `FAILED` → `REJECTED` com `REFERENCE_NOT_PROCESSED` (a operação original nunca aconteceu).
9. `LOSS` aceita valor `0.00` (registra o resultado da rodada); os demais kinds exigem valor maior que zero.
10. `PENDING` só existe em memória durante o processamento: a transação é gravada já no estado resultante (`PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`) na mesma transação SQL.
11. `WIN` e `LOSS` podem informar `referenceExternalTransactionId` (a `BET` da rodada). Se informada e ausente, aguardam em `PENDING_REFERENCE` como as reversões.

### 7.1 `PENDING_REFERENCE`
- Colunas `retry_attempts` e `next_retry_at`. O worker busca as devidas com `FOR UPDATE SKIP LOCKED` (várias réplicas sem disputa)
  e reprocessa sob o lock da wallet.
- Backoff exponencial: `min(2^n × 1s, 5min)` com jitter. Limite de **10 tentativas (~20 min no total)**. Justificativa: provedores
  costumam reenviar a referência em segundos. Depois de 20 min, segurar dinheiro "no limbo" é pior que rejeitar. Valor configurável.
- Esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- **Otimização:** ao processar uma transação, na mesma transação SQL, tentamos resolver as pendentes que referenciam o seu
  `externalTransactionId`. O worker continua sendo a garantia.

### 7.2 Taxonomia de `failureCode`

| Código | Tipo | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | negócio | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | negócio | escalar para operação |
| `CURRENCY_MISMATCH` | negócio | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | negócio | corrigir payload |
| `REFERENCE_NOT_FOUND` | negócio (após TTL) | desistir ou investigar |
| `REFERENCE_MISMATCH` | negócio | corrigir payload |
| `REFERENCE_INVALID_KIND` | negócio | corrigir payload |
| `REFERENCE_ALREADY_REVERSED` | negócio | desistir (já foi revertida) |
| `REFERENCE_AMOUNT_MISMATCH` | negócio | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | negócio | desistir (a referência foi rejeitada) |
| `PROVIDER_MISMATCH` | segurança | o token não pertence ao `providerId` |
| `INFRA_PERMANENT_FAILURE` | `FAILED` | auditoria, foi para a DLQ |

---

## 8. HTTP: mapeamento de status

| Situação | Status | Corpo |
|---|---|---|
| Processada agora | `201` | `idempotentReplay: false` |
| Replay de processada | `200` | `idempotentReplay: true` |
| Payload inválido ou header ausente | `400` | `code: VALIDATION_ERROR` + detalhes |
| Sem token ou token inválido | `401` | |
| Token de outro provider | `403` | `PROVIDER_MISMATCH` |
| Wallet ou transação inexistente | `404` | |
| Conflito de idempotência | `409` | `code: IDEMPOTENCY_KEY_CONFLICT` |
| Mesmo external id com outra key | `409` | `code: EXTERNAL_TRANSACTION_CONFLICT` |
| Wallet duplicada | `409` | `code: WALLET_ALREADY_EXISTS` |
| Rejeição por regra de negócio | `422` | `status: REJECTED`, `failureCode` (replay → `422` de novo, com `idempotentReplay: true`) |
| Replay de transação `FAILED` | `422` | `status: FAILED`, `failureCode: INFRA_PERMANENT_FAILURE` |
| Aceita, aguardando referência | `202` | `status: PENDING_REFERENCE` |
| Falha transitória (DB, lock timeout) | `503` + `Retry-After` | `code: TRANSIENT_FAILURE` (pode reenviar) |

Regra simples para o provedor: **4xx não reenvie igual, 202 aguarde, 503 reenvie.**

---

## 9. SQS

- Filas: `wager-transactions.fifo` com `RedrivePolicy` (`maxReceiveCount = 5`) para `wager-transactions-dlq.fifo`.
  Os eventos de integração vão para `wallet-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`). O README não define o destino dos eventos, então optamos por esta nomenclatura.
- Long polling (`WaitTimeSeconds = 20`), processamento concorrente entre grupos diferentes.
- Classificação de erros:
  - **negócio** → a transação é persistida como `REJECTED` → **ack**;
  - **transitório** (conexão, lock timeout, serialização) → `ChangeMessageVisibility` com backoff → a redrive policy manda para a DLQ após 5 tentativas;
  - **permanente** (JSON inválido, contrato inválido, `OPENING`, wallet inexistente, conflito de idempotência) → envio explícito para a DLQ + delete, com o motivo no atributo `failureReason`;
  - **tentativas esgotadas** (`ApproximateReceiveCount >= 5`) → a operação é registrada como `FAILED` / `INFRA_PERMANENT_FAILURE` (auditável, com evento) e a mensagem vai para a DLQ.
- Erros desconhecidos são tratados como transitórios: na dúvida, tentar de novo é seguro porque a inbox e a idempotency key impedem efeito duplicado.
- **ack somente após o commit.**
- `SIGTERM`: handler próprio no `main.ts` (o shutdown precisa de ordem). Para de buscar mensagens (aborta o long polling), aguarda as em andamento até `SHUTDOWN_GRACE_MS` (20s),
  devolve as restantes com `ChangeMessageVisibility(0)`, para os workers, fecha o HTTP e só então as conexões do banco. `stop_grace_period: 30s` no compose.

---

## 10. Transactional Outbox

- Eventos gravados na **mesma transação** da alteração financeira.
- Publisher (em todas as réplicas), em ciclos:
  1. **claim** em transação curta: `UPDATE outbox SET locked_until = now() + 30s WHERE id IN (SELECT id ... WHERE published_at IS NULL AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING *`;
  2. publica no SQS **fora** da transação (nenhum lock fica preso durante I/O de rede);
  3. `markPublished` ou `scheduleRetry` (backoff exponencial).
- Se o processo morrer depois do commit e antes de publicar, o lease expira e outra réplica assume. Isso é **at-least-once** e a duplicata é segura porque o
  consumidor deduplica por `eventId` (e o FIFO deduplica por 5 min como bônus).
- Métrica `outbox_lag_seconds` = `now() - min(occurred_at)` dos pendentes.

---

## 11. Autenticação (Keycloak)

- Keycloak no compose, banco `keycloak` no mesmo PostgreSQL (separado do `jungle`), realm `jungle` importado de `docker/keycloak/realm-jungle.json`.
- **Provedores** = clients confidenciais com *client credentials grant* (`provider-a`, `provider-b`). O token carrega o `azp`/claim `provider_id`.
- **Back-office** (criar wallet, reconciliação, consultas) = role `wallet-admin`.
- A app valida o JWT localmente pelo JWKS do Keycloak (`jose`, com cache de chaves). Não há chamada ao IdP por requisição.
- A identidade do provedor fica na borda: `JwtVerifier` (infraestrutura) produz um `Principal`, e `assertActsAsProvider` (adapter HTTP) exige que o `providerId` do body seja igual ao claim `provider_id` do token, senão `403 PROVIDER_MISMATCH`. Os use cases não conhecem autenticação.
- `AUTH_ENABLED=false` desliga a validação (útil para depuração local); o padrão no compose é `true`.
- Health e métricas ficam abertos. Mensagens SQS são canal interno confiável, mas o `providerId` continua passando pelas regras de domínio.
- **Trade-off:** o Keycloak pesa cerca de 500MB de RAM e 20–40s de boot. Os testes de integração obtêm tokens reais via client credentials.

---

## 12. Observabilidade

- Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` via `AsyncLocalStorage`. **Sem** valores monetários nem payloads completos.
- Métricas: `wager_transactions_total{kind,status}`, `idempotent_replays_total`, `inbox_duplicates_total`, `sqs_retries_total`,
  `sqs_dlq_total`, `wallet_lock_conflicts_total`, `outbox_lag_seconds`, `outbox_pending`, `wager_processing_duration_seconds` (histograma),
  `reconciliation_divergences_total`.
- `GET /health/live` (processo) e `GET /health/ready` (`SELECT 1` + `GetQueueAttributes`).

---

## 13. Docker e testes

- Rede `jungle`. Serviços: `postgres` (cria `chimp`/`jungle` e o banco do Keycloak via script de init), `localstack` (cria as filas no init),
  `keycloak`, `app` (3 réplicas), `migrate` (job que roda as migrations antes da app) e `test` (Bun, roda as suítes).
- Nada é instalado na máquina: `docker compose run --rm test bun test`, `bun run test:load` também em container.
- Testes de concorrência usam **paralelismo real**: requisições simultâneas contra as 3 réplicas e publishers/workers concorrentes
  sobre a mesma outbox. Crash é real: `SIGKILL` de uma instância via Docker Engine API (o socket é montado no container `test`) e um processo
  filho que morre com `exit(137)` logo depois do commit e antes do ack.
- Duas classes de teste, dois bancos:
  - **caixa-preta** (`test/concurrency`): HTTP + SQS contra as 3 instâncias reais, banco `jungle`, tokens reais do Keycloak;
  - **in-process** (`test/integration`): o mesmo composition root da aplicação, banco isolado `jungle_test` (schema recriado a cada suíte) e filas SQS exclusivas por teste.
- Invariante final de toda suíte: `wallet.balance == soma do ledger`.

---

## 14. Limitações conhecidas e trade-offs

- Moeda única (BRL) nos cenários, com o modelo multi-moeda testado em conflito.
- Sem ledger de partidas dobradas (diferencial opcional). O ledger é de partida simples, mas encadeado por versão e verificado no banco.
- Usuário de runtime igual ao owner das migrations (os triggers cobrem a imutabilidade, mas um owner pode desabilitá-los).
- **Hot wallet**: o lock por linha serializa a wallet. É correto por construção, mas o throughput de uma única wallet é limitado pela
  latência de uma transação (alguns ms). O teste de carga mostra o efeito no p95/p99 quando 10% do tráfego vai para uma wallet.
- O `issuer` dos tokens é fixo (`KC_HOSTNAME=http://keycloak:8080`) para que tokens obtidos de dentro e de fora da rede Docker sejam aceitos.
- Escritas usam inserts/updates nativos do MikroORM em ordem explícita, em vez do flush automático do Unit of Work: a ordem importa para as FKs
  e para o trigger que casa cada `UPDATE` da wallet com exatamente um lançamento. As leituras usam o `EntityManager` (identity map por unidade de trabalho).
- O evento de integração sai em `wallet-events.fifo`; não há consumidor desses eventos no escopo do desafio.
- LocalStack e um único PostgreSQL: não testamos failover do banco nem particionamento de rede entre instâncias.
