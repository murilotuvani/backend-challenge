import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadDatabaseConfig } from '../config/env';
import { Migration20261030000001_initial_schema } from './migrations/Migration20261030000001_initial_schema';
import { persistenceSchemas } from './schemas';

/**
 * Migrations listadas explicitamente (sem glob): ordem determinística e funciona igual
 * em Bun, em container e em testes.
 */
export const migrationsList = [
  { name: 'Migration20261030000001_initial_schema', class: Migration20261030000001_initial_schema },
];

export interface OrmOverrides {
  poolMax?: number;
  dbName?: string;
}

export function buildOrmConfig(overrides: OrmOverrides = {}) {
  const db = loadDatabaseConfig();
  return defineConfig({
    host: db.host,
    port: db.port,
    dbName: overrides.dbName ?? db.dbName,
    user: db.user,
    password: db.password,
    entities: persistenceSchemas,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      transactional: true,
      allOrNothing: true,
      tableName: 'mikro_orm_migrations',
      silent: true,
    },
    pool: {
      min: 0,
      max: overrides.poolMax ?? db.poolMax,
      // lock_timeout transforma espera longa por lock de wallet em erro transitório (55P03).
      afterCreate: (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) => {
        conn.query(
          `set lock_timeout = ${db.lockTimeoutMs}; set statement_timeout = ${db.statementTimeoutMs}; set timezone = 'UTC';`,
          (err) => done(err, conn),
        );
      },
    },
    // Uma única fonte da verdade para o schema: as migrations, nunca o schema generator.
    ensureDatabase: false,
    allowGlobalContext: false,
    debug: false,
  });
}
