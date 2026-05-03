import { SqliteDialect } from 'kysely';
import type { SqlStorage } from './types.js';

const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|savepoint|release)\b/i;

// DO's `SqlStorageValue` is `ArrayBuffer | string | number | null` — `bigint`
// is rejected at the binding layer. Convert to string so SQLite still parses
// the value into its native 64-bit INTEGER column without truncation.
function coerceParams(params: ReadonlyArray<unknown>): unknown[] {
  let needsCopy = false;
  for (const p of params) {
    if (typeof p === 'bigint') {
      needsCopy = true;
      break;
    }
  }
  if (!needsCopy) return params as unknown[];
  return params.map((p) => (typeof p === 'bigint' ? p.toString() : p));
}

/**
 * Kysely dialect for Cloudflare Durable Object SQLite storage.
 *
 * Bridges the `ctx.storage.sql` (`SqlStorage`) interface to the
 * `better-sqlite3`-compatible interface that Kysely's `SqliteDialect` expects.
 *
 * ## Usage with Kysely directly
 *
 * ```ts
 * import { Kysely } from 'kysely';
 * import { DurableObjectSqliteDialect } from 'kysely-durable-objects';
 *
 * export class MyDO extends DurableObject {
 *   private db: Kysely<MySchema>;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.db = new Kysely<MySchema>({
 *       dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
 *     });
 *   }
 * }
 * ```
 *
 * ## Usage with MikroORM
 *
 * ```ts
 * import { MikroORM } from '@mikro-orm/core';
 * import { SqliteDriver } from '@mikro-orm/sql';
 * import { DurableObjectSqliteDialect } from 'kysely-durable-objects';
 *
 * export class MyDO extends DurableObject {
 *   private orm: MikroORM;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     ctx.blockConcurrencyWhile(async () => {
 *       this.orm = await MikroORM.init({
 *         driver: SqliteDriver,
 *         dbName: 'do-storage',
 *         driverOptions: new DurableObjectSqliteDialect(ctx.storage.sql),
 *         implicitTransactions: false,
 *         compiledFunctions: ...,
 *         entities: [...],
 *       });
 *       await this.orm.schema.refreshDatabase();
 *     });
 *   }
 * }
 * ```
 */
export class DurableObjectSqliteDialect extends SqliteDialect {
  constructor(sql: SqlStorage) {
    super({
      database: () => ({
        prepare(query: string) {
          // Durable Objects block raw BEGIN/COMMIT/ROLLBACK/SAVEPOINT SQL, and
          // there is no way to safely bridge Kysely's stepwise async transaction
          // lifecycle (begin → many awaits → commit/rollback) onto DO's atomic
          // synchronous transactionSync(closure) primitive. Silently no-op'ing
          // these statements would turn rollback into a footgun — partial writes
          // would persist while the user code thought they had been undone.
          // For atomic blocks, use `ctx.storage.transactionSync(() => { ... })`
          // directly with raw `ctx.storage.sql.exec(...)` calls inside.
          if (TRANSACTION_CONTROL.test(query)) {
            throw new Error(
              'kysely-durable-objects: explicit transactions are not supported inside ' +
                'Durable Objects. Use ctx.storage.transactionSync(() => { ... }) ' +
                'with raw ctx.storage.sql.exec() calls for atomic blocks.',
            );
          }

          return {
            reader:
              /^\s*(select|pragma|explain|with)/i.test(query) ||
              /\breturning\b/i.test(query),

            all(params: ReadonlyArray<unknown>): unknown[] {
              return sql.exec(query, ...coerceParams(params)).toArray();
            },

            run(params: ReadonlyArray<unknown>): {
              changes: number | bigint;
              lastInsertRowid: number | bigint;
            } {
              sql.exec(query, ...coerceParams(params));
              // DO SqlStorage doesn't return changes/lastInsertRowid from exec(),
              // so we query SQLite's built-in functions to retrieve them.
              const changesResult = sql
                .exec<{ c: number }>('select changes() as c')
                .one();
              const lastIdResult = sql
                .exec<{ id: number }>('select last_insert_rowid() as id')
                .one();
              return {
                changes: changesResult.c,
                lastInsertRowid: lastIdResult.id,
              };
            },

            get(params: ReadonlyArray<unknown>): unknown {
              const rows = sql.exec(query, ...coerceParams(params)).toArray();
              return rows[0];
            },

            *iterate(params: ReadonlyArray<unknown>): IterableIterator<unknown> {
              for (const row of sql.exec(query, ...coerceParams(params))) {
                yield row;
              }
            },
          };
        },

        close(): void {
          // Durable Objects manage their own SQLite lifecycle.
          // This is a no-op — the storage is tied to the DO instance.
        },
      }) as any,
    });
  }

  /**
   * MikroORM's `Utils.copy()` deep-clones `driverOptions` inside the Connection
   * constructor, which would sever the closure around `ctx.storage.sql` and
   * yield a broken dialect. Returning `this` short-circuits that path.
   */
  clone(): this {
    return this;
  }
}
