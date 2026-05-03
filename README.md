# kysely-durable-objects

[![CI](https://github.com/jeffwilde/kysely-durable-objects/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffwilde/kysely-durable-objects/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kysely-durable-objects.svg)](https://www.npmjs.com/package/kysely-durable-objects)

[Kysely](https://kysely.dev/) dialect for [Cloudflare Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) (`ctx.storage.sql`). Bridges the DO `SqlStorage` API to the `better-sqlite3`-compatible interface Kysely expects.

## Install

```bash
npm install kysely-durable-objects kysely
```

`kysely` is a peer dependency.

## Usage

### Kysely

```ts
import { Kysely } from 'kysely';
import { DurableObjectSqliteDialect } from 'kysely-durable-objects';
import { DurableObject } from 'cloudflare:workers';

interface Schema {
  users: { id: number; name: string; email: string };
}

export class MyDO extends DurableObject {
  private db: Kysely<Schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Kysely<Schema>({
      dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
    });
  }
}
```

### MikroORM

MikroORM v7 uses Kysely under the hood and accepts any Kysely dialect via `driverOptions`.

```ts
import { MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sql';
import { DurableObjectSqliteDialect } from 'kysely-durable-objects';
import compiledFunctions from './compiled-functions.js';

ctx.blockConcurrencyWhile(async () => {
  this.orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: 'do',
    driverOptions: new DurableObjectSqliteDialect(ctx.storage.sql),
    entities: [...],
    implicitTransactions: false, // required: BEGIN is blocked in DOs
    compiledFunctions,           // required: new Function() is blocked in DOs
  });
});
```

Pre-generate compiled functions with `npx mikro-orm compile`. See the [MikroORM deployment docs](https://mikro-orm.io/docs/deployment#pre-build-compiled-functions).

### Atomicity (`withDoTransaction`)

`db.transaction()` **throws** on this dialect — there is no safe way to bridge Kysely's async stepwise BEGIN/COMMIT/ROLLBACK lifecycle to DO's synchronous `transactionSync(closure)` primitive. For atomic blocks, use the bundled helper:

```ts
import { withDoTransaction } from 'kysely-durable-objects';

withDoTransaction(ctx.storage, (sql) => {
  sql.exec('update accounts set balance = balance - ? where id = ?', 100, fromId);
  sql.exec('update accounts set balance = balance + ? where id = ?', 100, toId);
});
```

Throwing inside the closure rolls back. The closure is synchronous — that's a hard constraint of `transactionSync`.

## Limitations

- **Explicit transactions throw.** Use `withDoTransaction`. With MikroORM, set `implicitTransactions: false`.
- **`changes()` and `last_insert_rowid()` are separate queries.** Two extra SELECTs after each mutation. Safe because storage operations are serialized inside a DO.
- **`BigInt` parameters are coerced to strings** before binding. SQLite parses them into native 64-bit `INTEGER` without truncation.
- **`BigInt` values > 2^53 lose precision on direct read.** DO returns `INTEGER` columns as JS `Number`. Recover the full 64-bit value with `CAST(col AS TEXT)`.
- **No prepared-statement caching.** DO storage handles its own optimization.

## API

```ts
new DurableObjectSqliteDialect(sql: SqlStorage): Dialect

withDoTransaction<T>(
  storage: { sql: SqlStorage; transactionSync<T>(fn: () => T): T },
  closure: (sql: SqlStorage) => T,
): T
```

Type re-exports for convenience: `SqlStorage`, `SqlStorageCursor`, `DurableObjectStorageLike` — mirror `@cloudflare/workers-types` so this package has no hard dependency on it.

## Migrations

Kysely's built-in `Migrator` works against this dialect. The `kysely_migration` and `kysely_migration_lock` tables are created automatically on first run; the lock table is semantically redundant in a DO (per-instance serialization already prevents concurrent migration), but harmless.

## Testing

```bash
npm test
```

Tests run inside the actual Cloudflare Workers runtime (`workerd`) via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), against real `ctx.storage.sql` inside a real Durable Object. Where the local runner diverges from production, the suite simulates the production constraint.

## TODO

- Real-DO sanity mode — opt-in suite that deploys an ephemeral Worker + DO to a real Cloudflare account and runs the full test matrix against production runtime

## License

MIT
