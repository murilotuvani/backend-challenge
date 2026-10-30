import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras ficam no banco (README §5.9), não só no código:
 *
 * - unicidade: wallet por (player, moeda), transação por (provider, external id) e por idempotency key,
 *   um lançamento por (transação, wallet), uma reversão processada por referência, inbox por (consumer, message);
 * - não-negatividade: CHECK em saldo e em saldos do ledger;
 * - imutabilidade: triggers bloqueiam UPDATE/DELETE/TRUNCATE no ledger e transições a partir de estados terminais;
 * - consistência saldo ↔ ledger: constraint trigger DEFERRED valida, no commit, que toda mudança de saldo
 *   tem exatamente o lançamento correspondente (e vice-versa), encadeado por wallet_version.
 */
export class Migration20261030000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id              uuid primary key,
        player_id       uuid not null,
        currency        char(3) not null,
        balance_amount  numeric(20,2) not null,
        version         integer not null,
        created_at      timestamptz not null,
        updated_at      timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_currency_iso_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance_amount >= 0),
        constraint wallets_version_positive_ck check (version >= 1)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       text not null,
        external_transaction_id           text not null,
        idempotency_key                   text not null,
        payload_hash                      char(64) not null,
        wallet_id                         uuid not null references wallets (id),
        player_id                         uuid not null,
        round_id                          text not null,
        game_id                           text not null,
        kind                              text not null,
        amount                            numeric(20,2) not null,
        currency                          char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        status                            text not null,
        failure_code                      text,
        resulting_balance_amount          numeric(20,2),
        resulting_balance_currency        char(3),
        reference_attempts                integer not null default 0,
        next_reference_check_at           timestamptz,
        created_at                        timestamptz not null,
        processed_at                      timestamptz,
        updated_at                        timestamptz not null,
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        -- alvo da FK composta abaixo: garante que a referência pertence à mesma wallet
        constraint wager_transactions_id_wallet_uq unique (id, wallet_id),
        constraint wager_transactions_reference_same_wallet_fk
          foreign key (reference_transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint wager_transactions_kind_ck
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_transactions_status_ck
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_transactions_amount_ck
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_currency_iso_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_reversal_requires_reference_ck
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_processed_reversal_resolved_ck
          check (status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null),
        constraint wager_transactions_processed_at_ck
          check (status <> 'PROCESSED' or processed_at is not null),
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_transactions_pending_reference_schedule_ck
          check (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null),
        constraint wager_transactions_reference_attempts_ck check (reference_attempts >= 0),
        constraint wager_transactions_resulting_balance_ck
          check ((resulting_balance_amount is null) = (resulting_balance_currency is null)
                 and (resulting_balance_amount is null or resulting_balance_amount >= 0))
      );
    `);

    this.addSql(`
      -- Regra estrita (ARCHITECTURE §7.1): uma transação só pode ser revertida uma vez, por qualquer tipo.
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_due_idx
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_transactions_waiting_for_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      create table wallet_ledger_entries (
        id                    uuid primary key,
        sequence              bigint generated always as identity,
        wallet_id             uuid not null references wallets (id),
        transaction_id        uuid not null,
        direction             text not null,
        amount                numeric(20,2) not null,
        currency              char(3) not null,
        balance_before_amount numeric(20,2) not null,
        balance_after_amount  numeric(20,2) not null,
        wallet_version        integer not null,
        created_at            timestamptz not null,
        constraint wallet_ledger_entries_transaction_wallet_uq unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_wallet_version_uq unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT','CREDIT')),
        constraint wallet_ledger_entries_amount_positive_ck check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative_ck
          check (balance_before_amount >= 0 and balance_after_amount >= 0),
        constraint wallet_ledger_entries_balanced_ck check (
          (direction = 'CREDIT' and balance_after_amount = balance_before_amount + amount) or
          (direction = 'DEBIT'  and balance_after_amount = balance_before_amount - amount)
        ),
        constraint wallet_ledger_entries_version_ck check (wallet_version >= 1)
      );
    `);

    // ---- imutabilidade do ledger --------------------------------------------------------
    this.addSql(`
      create function ledger_entries_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% not allowed)', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function ledger_entries_immutable();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function ledger_entries_immutable();
    `);

    // ---- wallets: campos imutáveis, sem delete ----------------------------------------------
    this.addSql(`
      create function wallets_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet identity columns are immutable' using errcode = 'restrict_violation';
        end if;
        if new.balance_amount = old.balance_amount and new.version <> old.version then
          raise exception 'wallet version may only change together with the balance'
            using errcode = 'check_violation';
        end if;
        if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
          raise exception 'wallet version must increment by exactly 1 per balance change'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallets_guard
        before update or delete on wallets
        for each row execute function wallets_guard();
    `);

    // ---- consistência saldo ↔ ledger (verificada no commit) ------------------------------
    this.addSql(`
      create function wallets_ledger_consistency() returns trigger language plpgsql as $$
      declare
        expected_before numeric(20,2);
      begin
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'wallet % must be created with version 1', new.id using errcode = 'check_violation';
          end if;
          if new.balance_amount = 0 then
            return null;
          end if;
          expected_before := 0;
        else
          if new.balance_amount = old.balance_amount then
            return null;
          end if;
          expected_before := old.balance_amount;
        end if;

        if not exists (
          select 1 from wallet_ledger_entries e
           where e.wallet_id = new.id
             and e.wallet_version = new.version
             and e.balance_before_amount = expected_before
             and e.balance_after_amount = new.balance_amount
             and e.currency = new.currency
        ) then
          raise exception 'balance change of wallet % (version %) has no matching ledger entry', new.id, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_ledger_consistency
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_ledger_consistency();
    `);
    this.addSql(`
      create function ledger_entries_match_wallet() returns trigger language plpgsql as $$
      declare
        current_version integer;
        wallet_currency char(3);
      begin
        select version, currency into current_version, wallet_currency from wallets where id = new.wallet_id;
        if current_version is null or current_version < new.wallet_version then
          raise exception 'ledger entry % references wallet version % that was never reached', new.id, new.wallet_version
            using errcode = 'integrity_constraint_violation';
        end if;
        if wallet_currency <> new.currency then
          raise exception 'ledger entry % currency differs from wallet', new.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function ledger_entries_match_wallet();
    `);

    // ---- transações: estados terminais e identidade imutáveis -------------------------------
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'transaction % is terminal (%)', old.id, old.status using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'transaction % identity columns are immutable', old.id using errcode = 'restrict_violation';
        end if;
        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'transaction % cannot go back to PENDING', old.id using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    // ---- inbox / outbox -----------------------------------------------------------------
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id    text not null,
        payload_hash  char(64) not null,
        received_at   timestamptz not null,
        processed_at  timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);
    this.addSql(`
      create table outbox_messages (
        id              uuid primary key,
        aggregate_id    uuid not null,
        event_type      text not null,
        payload         jsonb not null,
        occurred_at     timestamptz not null,
        attempts        integer not null default 0,
        next_attempt_at timestamptz not null,
        locked_until    timestamptz,
        last_error      text,
        published_at    timestamptz,
        constraint outbox_messages_attempts_ck check (attempts >= 0)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists ledger_entries_immutable();`);
    this.addSql(`drop function if exists wallets_guard();`);
    this.addSql(`drop function if exists wallets_ledger_consistency();`);
    this.addSql(`drop function if exists ledger_entries_match_wallet();`);
    this.addSql(`drop function if exists wager_transactions_guard();`);
  }
}
