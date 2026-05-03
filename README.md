# kysely-durable-objects

[![CI](https://github.com/jeffwilde/kysely-durable-objects/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffwilde/kysely-durable-objects/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kysely-durable-objects.svg)](https://www.npmjs.com/package/kysely-durable-objects)

[Kysely](https://kysely.dev/) dialect for [Cloudflare Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) (`ctx.storage.sql`). Hardened against the runtime's quirks, with a comprehensive test suite that exercises the dialect inside real `workerd`.

## Highlights

- **Real `insertId`.** `last_insert_rowid()` is queried after every mutation, so `RETURNING` clauses, Kysely's `numAffectedRows`, and MikroORM's identity tracking all work end-to-end.
- **`BigInt` parameters that actually bind.** DO's `SqlStorageValue` rejects `bigint`, so the dialect transparently stringifies bigints before binding. SQLite parses the string into a native 64-bit `INTEGER` without truncation.
- **Honest transactions.** `db.transaction()` throws an actionable error pointing to the bundled `withDoTransaction` helper. We never silently drop `BEGIN` — a no-op rollback would let earlier writes persist while user code thought they had been undone.
- **MikroORM-ready.** `clone()` returns the same instance, so MikroORM's `Utils.copy()` deep-clone of `driverOptions` doesn't sever the closure around `ctx.storage.sql`.
- **Eval-free.** Every code path runs under workerd's production `new Function()` ban. The test suite proves it by patching `Function`/`eval` to throw and re-running the full CRUD path.

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

`db.transaction()` throws on this dialect — there is no safe way to bridge Kysely's async stepwise BEGIN/COMMIT/ROLLBACK lifecycle to DO's synchronous `transactionSync(closure)` primitive. For atomic blocks, use the bundled helper:

```ts
import { withDoTransaction } from 'kysely-durable-objects';

withDoTransaction(ctx.storage, (sql) => {
  sql.exec('update accounts set balance = balance - ? where id = ?', 100, fromId);
  sql.exec('update accounts set balance = balance + ? where id = ?', 100, toId);
});
```

Throwing inside the closure rolls back. The closure is synchronous — that's a hard constraint of `transactionSync`.

## Tested in real workerd

26 tests, all running inside the same C++ runtime Cloudflare deploys (via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)), against real `ctx.storage.sql`:

- **CRUD & isolation** — schema builder, INSERT/SELECT/UPDATE/DELETE, RETURNING, auto-increment, per-DO storage isolation, `runInDurableObject` introspection, `destroy()` semantics.
- **Eval-guarded CRUD** — full CRUD path re-run with `Function`/`eval` patched to throw, simulating the production `new Function()` ban that the local runner relaxes.
- **`withDoTransaction`** — commit and rollback semantics under real `transactionSync`.
- **Kysely Migrator end-to-end** — runs real migrations, verifies the `kysely_migration` tracking table populates correctly, and that the target schema lands.
- **Type fidelity** — `NULL` across all column affinities, `BLOB` (`Uint8Array`) bit-exact roundtrip, `BigInt` within and beyond JS safe-integer range, `REAL` precision, dates as integer ms, JSON text + `json_extract()`.
- **Concurrency** — reproduces the `await`-boundary lost-update race and proves `blockConcurrencyWhile` mitigates it.

```bash
npm test
```

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

Kysely's built-in `Migrator` works against this dialect end-to-end. The `kysely_migration` and `kysely_migration_lock` tables are created automatically on first run; the lock table is semantically redundant inside a DO (per-instance serialization already prevents concurrent migration), but harmless.

## Platform notes

These are properties of the Durable Object runtime, not of this dialect. They're called out so consumers can plan around them.

- **`new Function()` / `eval()` are banned** during request handling. The dialect's hot path is eval-free; if you use MikroORM, configure `compiledFunctions` to ship pre-compiled query plans.
- **No raw `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`.** DO storage exposes atomicity only via `ctx.storage.transactionSync(closure)`. Use `withDoTransaction` (above).
- **`INTEGER` columns return as JS `Number`.** `BigInt` values up to 2^53 roundtrip bit-exactly. Beyond that, the value lands in storage intact (we coerce on write) but a direct read rounds. Recover the full 64-bit value with `CAST(col AS TEXT)`:
  ```sql
  SELECT CAST(big_id AS TEXT) AS big_id_str FROM ledger WHERE ...
  ```
- **`changes()` and `last_insert_rowid()` aren't returned by `exec()`.** The dialect issues two extra `SELECT` calls after each mutation to retrieve them. Safe — storage operations inside a DO are serialized.
- **Async workflows can interleave at `await` boundaries.** Per-instance serialization is at the storage operation level, not at the application code level. For read-modify-write across awaits, wrap with `ctx.blockConcurrencyWhile`.

## TODO

- Real-DO sanity mode — opt-in suite that deploys an ephemeral Worker + DO to a real Cloudflare account and runs the full test matrix against production runtime

## License

MIT
