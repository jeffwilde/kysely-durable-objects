# kysely-durable-objects

[Kysely](https://kysely.dev/) dialect for [Cloudflare Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) (`ctx.storage.sql`).

Bridges the DO `SqlStorage` API to the `better-sqlite3`-compatible interface that Kysely expects, so you can use Kysely's full query builder and schema API inside Durable Objects.

## Install

```bash
npm install kysely-durable-objects kysely
```

`kysely` is a peer dependency — install it alongside this package.

## Usage

### With Kysely directly

```ts
import { Kysely } from 'kysely';
import { DurableObjectSqliteDialect } from 'kysely-durable-objects';
import { DurableObject } from 'cloudflare:workers';

interface MySchema {
  users: {
    id: number;
    name: string;
    email: string;
  };
}

export class MyDO extends DurableObject {
  private db: Kysely<MySchema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Kysely<MySchema>({
      dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
    });
  }

  async getUsers() {
    return this.db.selectFrom('users').selectAll().execute();
  }

  async addUser(name: string, email: string) {
    return this.db
      .insertInto('users')
      .values({ name, email })
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow();
  }
}
```

### With MikroORM

This dialect was built specifically to enable [MikroORM](https://mikro-orm.io/) in Cloudflare Durable Objects. MikroORM v7 uses Kysely under the hood and accepts any Kysely dialect via `driverOptions`:

```ts
import { MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sql';
import { DurableObjectSqliteDialect } from 'kysely-durable-objects';
import { DurableObject } from 'cloudflare:workers';
import compiledFunctions from './compiled-functions.js';
import { User, Post } from './entities.js';

export class MyDO extends DurableObject {
  private orm!: MikroORM;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.orm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: 'do-storage',
        driverOptions: new DurableObjectSqliteDialect(ctx.storage.sql),
        entities: [User, Post],

        // Required for Durable Objects:
        implicitTransactions: false, // DO storage doesn't support explicit transactions
        compiledFunctions,           // Pre-compiled functions (new Function() is blocked in DOs)
      });
    });
  }

  async getUser(id: number) {
    return this.orm.em.fork().findOne(User, id);
  }
}
```

> **Important**: Durable Objects prohibit `new Function()` / `eval()` during request handling.
> You must pre-generate compiled functions with `npx mikro-orm compile` and pass them in config.
> See the [MikroORM deployment docs](https://mikro-orm.io/docs/deployment#pre-build-compiled-functions) for details.

## How it works

The dialect bridges DO `SqlStorage` to the `better-sqlite3` interface that Kysely's `SqliteDialect` expects:

| Kysely expects | DO SqlStorage provides | Bridge |
|---|---|---|
| `db.prepare(sql).all(params)` | `sql.exec(query, ...params).toArray()` | Direct mapping |
| `db.prepare(sql).run(params)` → `{ changes, lastInsertRowid }` | `sql.exec(query, ...params)` (no return metadata) | Queries `SELECT changes()` and `SELECT last_insert_rowid()` after mutations |
| `db.prepare(sql).get(params)` | `sql.exec(query, ...params).toArray()[0]` | Takes first row |
| `db.prepare(sql).iterate(params)` | `sql.exec(query, ...params)[Symbol.iterator]` | Direct mapping |
| `db.close()` | N/A (DO manages lifecycle) | No-op |

### Atomicity: `withDoTransaction` helper

Explicit `db.transaction()` calls **throw** in this dialect — see the limitations section below for why. For atomic blocks, use the bundled helper, which wraps `ctx.storage.transactionSync()`:

```ts
import { withDoTransaction } from 'kysely-durable-objects';

withDoTransaction(ctx.storage, (sql) => {
  sql.exec('update accounts set balance = balance - ? where id = ?', 100, fromId);
  sql.exec('update accounts set balance = balance + ? where id = ?', 100, toId);
});
```

If the closure throws, the transaction is rolled back. The closure is synchronous — that's a hard constraint of `transactionSync`.

### Type fidelity

The dialect exercises real `ctx.storage.sql` in workerd tests for these column types: `NULL`, `BLOB` (Uint8Array), `BigInt`, `REAL`, dates (stored as integer ms), and JSON (TEXT + `json_extract()`). Two notable behaviors:

- **`BigInt` parameters are coerced to strings** before binding — DO's `SqlStorageValue` rejects `bigint`, but SQLite parses the string into native 64-bit `INTEGER` without truncation.
- **`BigInt` values > 2^53 lose precision on direct read** — DO returns `INTEGER` columns as JS `Number`. To recover the full 64-bit value, read the column with `CAST(col AS TEXT)`.

### Limitations

- **Explicit transactions throw**: Durable Objects block raw `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` SQL, and there is no way to safely bridge Kysely's stepwise async transaction lifecycle (begin → many awaits → commit/rollback) onto DO's atomic synchronous `transactionSync(closure)` primitive. The dialect throws with a clear message rather than silently dropping `BEGIN` — a no-op rollback would leave partial writes intact while user code thought they had been undone. Use `withDoTransaction` (above) for atomic blocks. With MikroORM, set `implicitTransactions: false` so the ORM never issues `BEGIN`.
- **`changes()` / `last_insert_rowid()` are separate queries**: After each mutation, two additional `SELECT` calls retrieve the metadata. This is safe because DOs are single-threaded (no concurrent request interleaving).
- **No prepared statement caching**: Each query creates a fresh `exec()` call. DO storage handles its own query optimization internally.
- **`BigInt` precision loss on read past 2^53** — see Type fidelity above.

## Testing

```bash
npm test
```

Tests run inside the actual Cloudflare Workers runtime (`workerd`) via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), against real `ctx.storage.sql` inside a real Durable Object. Where the local runner diverges from production behavior, the suite simulates the production constraint to keep the dialect honest.

## API

### `DurableObjectSqliteDialect`

```ts
import { DurableObjectSqliteDialect } from 'kysely-durable-objects';

new DurableObjectSqliteDialect(sql: SqlStorage)
```

**Parameters:**

- `sql` — The `SqlStorage` instance from `ctx.storage.sql` on a Durable Object.

**Returns:** A Kysely `Dialect` that can be passed to `new Kysely({ dialect })` or MikroORM's `driverOptions`.

### `withDoTransaction`

```ts
import { withDoTransaction } from 'kysely-durable-objects';

withDoTransaction<T>(
  storage: { sql: SqlStorage; transactionSync<T>(fn: () => T): T },
  closure: (sql: SqlStorage) => T,
): T
```

Atomic block of synchronous raw SQL. Throws roll back the transaction. See [Atomicity](#atomicity-withdotransaction-helper) above.

### Migrations

Kysely's built-in `Migrator` works against this dialect end-to-end. The `kysely_migration` and `kysely_migration_lock` tables are created automatically on first run; the lock table is semantically redundant inside a DO (per-instance serialization already prevents concurrent migration), but harmless.

### Types

```ts
import type { SqlStorage, SqlStorageCursor } from 'kysely-durable-objects';
```

TypeScript interfaces for the DO SQLite Storage API, exported for convenience. These mirror the types from `@cloudflare/workers-types` so you don't need a hard dependency on that package.

## TODO

- Real-DO sanity mode — opt-in suite that deploys an ephemeral Worker + DO to a real Cloudflare account and runs the full test matrix against production runtime

## License

MIT
