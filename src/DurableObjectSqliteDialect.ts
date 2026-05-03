import { SqliteDialect } from 'kysely';
import type { SqlStorage } from './types.js';

const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|savepoint|release)\b/i;

// DO's SqlStorageValue is `ArrayBuffer | string | number | null` — bigint is
// rejected at the binding layer. Stringifying lets SQLite parse the value
// into a native 64-bit INTEGER without truncation.
function coerceParams(params: ReadonlyArray<unknown>): unknown[] {
  for (const p of params) {
    if (typeof p === 'bigint') {
      return params.map((q) => (typeof q === 'bigint' ? q.toString() : q));
    }
  }
  return params as unknown[];
}

/**
 * Kysely dialect for Cloudflare Durable Object SQLite storage (`ctx.storage.sql`).
 *
 * See the README for usage with Kysely directly and with MikroORM.
 */
export class DurableObjectSqliteDialect extends SqliteDialect {
  constructor(sql: SqlStorage) {
    super({
      database: () => ({
        prepare(query: string) {
          if (TRANSACTION_CONTROL.test(query)) {
            // Durable Objects expose atomicity only via the synchronous
            // `transactionSync(closure)` primitive, which can't be bridged
            // to Kysely's async stepwise BEGIN/COMMIT/ROLLBACK lifecycle.
            // Throwing here prevents a silent rollback footgun.
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
              // `exec()` doesn't expose changes/lastInsertRowid; query SQLite for them.
              const c = sql.exec<{ c: number }>('select changes() as c').one();
              const i = sql.exec<{ id: number }>('select last_insert_rowid() as id').one();
              return { changes: c.c, lastInsertRowid: i.id };
            },

            get(params: ReadonlyArray<unknown>): unknown {
              return sql.exec(query, ...coerceParams(params)).toArray()[0];
            },

            *iterate(params: ReadonlyArray<unknown>): IterableIterator<unknown> {
              for (const row of sql.exec(query, ...coerceParams(params))) {
                yield row;
              }
            },
          };
        },

        close(): void {},
      }) as any,
    });
  }

  // MikroORM's Utils.copy() deep-clones driverOptions, which would sever the
  // closure around ctx.storage.sql. Returning `this` short-circuits that.
  clone(): this {
    return this;
  }
}
