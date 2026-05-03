# kysely-durable-objects

[![CI](https://github.com/jeffwilde/kysely-durable-objects/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffwilde/kysely-durable-objects/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kysely-durable-objects.svg)](https://www.npmjs.com/package/kysely-durable-objects)

[Kysely](https://kysely.dev/) dialect for [Cloudflare Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) (`ctx.storage.sql`). A fully tested, battle-ready dialect that respects the Durable Object runtime's constraints.

## Highlights

- **Comprehensively tested in real `workerd`.** 30+ tests run inside the same C++ runtime Cloudflare deploys, against real `ctx.storage.sql`. CI exercises the suite across a matrix of `compatibility_date` values (DO-SQLite GA → today) so silent API drift in the runtime can't sneak in. A production-parity guard re-runs the full CRUD path with `new Function()` patched to throw, proving the dialect doesn't rely on dynamic code generation.
- **`insertId` and `numAffectedRows` work end-to-end.** The dialect queries `last_insert_rowid()` and `changes()` after each mutation, so Kysely's `RETURNING`, `numAffectedRows`, and MikroORM identity tracking all behave correctly.
- **`BigInt` parameter binding.** DO's storage layer rejects `bigint` at the binding boundary. The dialect transparently stringifies bigints so SQLite parses them as native 64-bit `INTEGER` without truncation.
- **Honors DO atomicity semantics.** `db.transaction()` throws an actionable error pointing to the bundled `withDoTransaction` helper, which wraps `ctx.storage.transactionSync()`. The dialect never silently swallows a `BEGIN` — that would turn rollback into a corruption hazard.
- **MikroORM compatible.** `clone()` returns the same instance so MikroORM's `Utils.copy()` deep-clone of `driverOptions` preserves the closure around `ctx.storage.sql`.
- **Real error paths.** UNIQUE/NOT NULL violations and SQL syntax errors surface as real exceptions, tested in real workerd.
- **`UPSERT` (`ON CONFLICT DO UPDATE`)** with `RETURNING` works end-to-end.

## Install

```bash
npm install kysely-durable-objects kysely
```

`kysely` is a peer dependency.

A runnable example lives at [`examples/basic-worker/`](./examples/basic-worker/) — a Cloudflare Worker with a Durable Object using the dialect, including a `withDoTransaction` block. `git clone && cd examples/basic-worker && pnpm install && pnpm dev`.

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

30+ tests, all running inside the same C++ runtime Cloudflare deploys (via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)), against real `ctx.storage.sql`:

- **CRUD & isolation** — schema builder, INSERT/SELECT/UPDATE/DELETE, RETURNING, auto-increment, per-DO storage isolation, `runInDurableObject` introspection, `destroy()` semantics.
- **Eval-guarded CRUD** — full CRUD path re-run with `Function`/`eval` patched to throw, simulating the production `new Function()` ban that the local runner relaxes.
- **Error paths** — UNIQUE/NOT NULL constraint violations and SQL syntax errors surface as real exceptions.
- **`UPSERT`** — `INSERT ... ON CONFLICT DO UPDATE` with `RETURNING`.
- **`withDoTransaction`** — commit and rollback semantics under real `transactionSync`.
- **Kysely Migrator end-to-end** — runs real migrations, verifies the `kysely_migration` tracking table populates correctly, and that the target schema lands.
- **Type fidelity** — `NULL` across all column affinities, `BLOB` (`Uint8Array`) bit-exact roundtrip, `BigInt` within and beyond JS safe-integer range, `REAL` precision, dates as integer ms, JSON text + `json_extract()`.
- **Concurrency** — reproduces the `await`-boundary lost-update race and proves `blockConcurrencyWhile` mitigates it.

CI runs the full suite across a matrix of `compatibility_date` values, so any silent change to DO storage or Workers runtime behavior between releases is caught.

```bash
npm test
```

### Production smoke tests

A separate workflow ([`.github/workflows/smoke.yml`](./.github/workflows/smoke.yml)) deploys a focused smoke worker to a real Cloudflare account, runs a subset of the suite over HTTP against the actual production runtime, and tears the deployment down. Runs weekly on a cron and can be triggered manually. Requires three repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SMOKE_TOKEN` (random gating value).

This catches divergences between local `workerd` and the production runtime that the local matrix can't see.

## API

```ts
new DurableObjectSqliteDialect(sql: SqlStorage): Dialect

withDoTransaction<T>(
  storage: { sql: SqlStorage; transactionSync<T>(fn: () => T): T },
  closure: (sql: SqlStorage) => T,
): T

introspectSchema(sql: SqlStorage): TableSchema[]
generateKyselyDbInterface(tables: TableSchema[], opts?: { interfaceName?: string }): string
```

Type re-exports for convenience: `SqlStorage`, `SqlStorageCursor`, `DurableObjectStorageLike`, `ColumnInfo`, `TableSchema` — mirror `@cloudflare/workers-types` so this package has no hard dependency on it.

### Schema introspection (migration aid)

When migrating a hand-rolled `ctx.storage.sql.exec()` codebase into Kysely, run `introspectSchema(ctx.storage.sql)` from inside the DO and pipe the result through `generateKyselyDbInterface()` to bootstrap a Kysely `DB` interface from your existing schema. The result is a string of TypeScript you can paste into your project. SQLite type affinities map to TypeScript as `INTEGER`/`REAL` → `number`, `TEXT` → `string`, `BLOB` → `Uint8Array`, anything else → `unknown`. Nullable columns become `T | null`.

## Migrations

Kysely's built-in `Migrator` works against this dialect end-to-end. The `kysely_migration` and `kysely_migration_lock` tables are created automatically on first run; the lock table is semantically redundant inside a DO (per-instance serialization already prevents concurrent migration), but harmless.

## Compatibility

| | Tested against |
|---|---|
| **Kysely** | `^0.28.15` (peer dep `>=0.27.0`) |
| **MikroORM** | v7+ (uses Kysely under the hood) |
| **Cloudflare `compatibility_date`** | `2024-09-23` (DO SQLite GA) → `2026-04-06` (current); CI exercises 4 dates across that range |
| **Node** | `22` for the test/build toolchain (workerd ships its own runtime) |
| **Package manager** | `pnpm` (any modern version; `pnpm@10` pinned in `packageManager`) |

Kysely is a peer dependency. MikroORM is supported via `driverOptions`; see [Usage → MikroORM](#mikroorm).

## Platform limitations

Properties of the Durable Object runtime that consumers need to plan around. The dialect surfaces these honestly rather than hiding them.

- **`new Function()` / `eval()` are banned** during request handling. The dialect's hot path is eval-free; if you use MikroORM, configure `compiledFunctions` to ship pre-compiled query plans.
- **No raw `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`.** DO storage exposes atomicity only via `ctx.storage.transactionSync(closure)`. Use `withDoTransaction` (above).
- **`INTEGER` columns return as JS `Number`.** `BigInt` values up to 2^53 roundtrip bit-exactly. Beyond that, the value lands in storage intact (the dialect coerces on write) but a direct read rounds. Recover the full 64-bit value with `CAST(col AS TEXT)`:
  ```sql
  SELECT CAST(big_id AS TEXT) AS big_id_str FROM ledger WHERE ...
  ```
- **`changes()` and `last_insert_rowid()` aren't returned by `exec()`.** The dialect issues two extra `SELECT` calls after each mutation to retrieve them. Safe — storage operations inside a DO are serialized.
- **Async workflows can interleave at `await` boundaries.** Per-instance serialization is at the storage-operation level, not at the application code level. For read-modify-write across awaits, wrap with `ctx.blockConcurrencyWhile`.

## Performance

Single-row inserts measured against local workerd (`workerd 2026-04-30`, 2000 ops):

| Path | Throughput | Time / 2000 ops |
|---|---|---|
| Raw `ctx.storage.sql.exec()` | ~500K ops/s | ~4ms |
| Kysely via this dialect | ~44K ops/s | ~45ms |

The ~11× cost on the Kysely path is dominated by Kysely's query compilation plus the two SELECTs the dialect issues after each mutation to retrieve `changes()` and `last_insert_rowid()`. The benchmark runs as part of the workerd suite and emits numbers via `console.log` on each CI run.

## Roadmap

Items resolved in 0.2.0:

- ✅ **Schema introspector** — `introspectSchema` + `generateKyselyDbInterface` now ship as a one-shot migration aid. Strike if Cloudflare ever ships a native `wrangler do export`.
- ✅ **Chunked streaming was investigated and is unnecessary.** A workerd-level probe (checked in as `cursorIsLazy`) confirms `SqlStorageCursor` lazy-streams rows from SQLite — `rowsRead` is 0 or 1 before the first `next()` call and grows during iteration. Our `iterate()` path is already memory-efficient; pagination via `LIMIT/OFFSET` would only add roundtrips.
- ✅ **Overhead benchmark** — checked in and reports per-run.

Open:

- Real-world adoption signal before bumping to 1.0 — API is stable but not yet exercised outside this repo.

## License

MIT
