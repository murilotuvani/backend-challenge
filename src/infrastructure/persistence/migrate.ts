import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './mikro-orm.config';

/** Uso: bun run migrate.ts up|down [--to <name>] */
async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(buildOrmConfig({ poolMax: 1 }));
  try {
    const migrator = orm.getMigrator();
    if (direction === 'up') {
      const applied = await migrator.up();
      console.log(JSON.stringify({ msg: 'migrations applied', migrations: applied.map((m) => m.name) }));
    } else if (direction === 'down') {
      const reverted = await migrator.down();
      console.log(JSON.stringify({ msg: 'migration reverted', migrations: reverted.map((m) => m.name) }));
    } else if (direction === 'down-all') {
      const reverted = await migrator.down({ to: 0 });
      console.log(JSON.stringify({ msg: 'all migrations reverted', migrations: reverted.map((m) => m.name) }));
    } else {
      throw new Error(`Unknown direction ${direction}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'migration failed', error: String(err) }));
  process.exit(1);
});
