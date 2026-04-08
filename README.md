# kysely-do

[Kysely](https://kysely.dev/) dialect for [Cloudflare Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) (`ctx.storage.sql`).

Bridges the DO `SqlStorage` API to the `better-sqlite3`-compatible interface that Kysely expects, so you can use Kysely's full query builder and schema API inside Durable Objects.

## Install

```bash
npm install kysely-do kysely
```

`kysely` is a peer dependency — install it alongside this package.

## Usage

### With Kysely directly

```ts
import { Kysely } from 'kysely';
import { DurableObjectSqliteDialect } from 'kysely-do';
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
import { DurableObjectSqliteDialect } from 'kysely-do';
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

### Limitations

- **No explicit transactions**: DO SQLite storage doesn't support `BEGIN`/`COMMIT`. Each `exec()` call is atomic. Set `implicitTransactions: false` when using with MikroORM.
- **`changes()` / `last_insert_rowid()` are separate queries**: After each mutation, two additional `SELECT` calls retrieve the metadata. This is safe because DOs are single-threaded (no concurrent request interleaving).
- **No prepared statement caching**: Each query creates a fresh `exec()` call. DO storage handles its own query optimization internally.

## Testing

### Unit tests (Node.js)

```bash
npm test
```

Runs tests with a mock `SqlStorage` implementation — useful for fast iteration and CI.

### Integration tests (workerd)

```bash
npm run test:workerd
```

Runs tests inside the actual Cloudflare Workers runtime (`workerd`) via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/). These tests:

- Execute inside real `workerd` — not mocked, not simulated
- Use actual DO SQLite storage with per-test isolation
- Verify `new Function()` is blocked (confirming `compiledFunctions` is necessary)
- Test full CRUD operations through the dialect

## API

### `DurableObjectSqliteDialect`

```ts
import { DurableObjectSqliteDialect } from 'kysely-do';

new DurableObjectSqliteDialect(sql: SqlStorage)
```

**Parameters:**

- `sql` — The `SqlStorage` instance from `ctx.storage.sql` on a Durable Object.

**Returns:** A Kysely `Dialect` that can be passed to `new Kysely({ dialect })` or MikroORM's `driverOptions`.

### Types

```ts
import type { SqlStorage, SqlStorageCursor } from 'kysely-do';
```

TypeScript interfaces for the DO SQLite Storage API, exported for convenience. These mirror the types from `@cloudflare/workers-types` so you don't need a hard dependency on that package.

## License

MIT
