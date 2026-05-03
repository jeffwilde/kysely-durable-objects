import type { SqlStorage } from './types.js';

/**
 * Subset of `DurableObjectStorage` we need: just the `transactionSync`
 * primitive and the `sql` handle. Mirrors `@cloudflare/workers-types`
 * without forcing a hard dependency.
 */
export interface DurableObjectStorageLike {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

/**
 * Run an atomic block of synchronous SQL operations against `ctx.storage.sql`.
 *
 * Durable Object SQL storage exposes atomicity only via `storage.transactionSync`,
 * which takes a synchronous closure. Kysely's stepwise async transaction API
 * (BEGIN → many awaits → COMMIT/ROLLBACK) cannot be safely bridged to that
 * primitive — see `DurableObjectSqliteDialect`'s thrown error for context.
 *
 * This helper is the documented escape hatch: when you need atomicity, drop
 * down to raw `SqlStorage.exec()` calls inside a sync closure.
 *
 * @example
 * ```ts
 * import { withDoTransaction } from 'kysely-durable-objects';
 *
 * withDoTransaction(ctx.storage, (sql) => {
 *   sql.exec('update accounts set balance = balance - ? where id = ?', 100, fromId);
 *   sql.exec('update accounts set balance = balance + ? where id = ?', 100, toId);
 * });
 * ```
 *
 * If the closure throws, the transaction is rolled back.
 */
export function withDoTransaction<T>(
  storage: DurableObjectStorageLike,
  closure: (sql: SqlStorage) => T,
): T {
  return storage.transactionSync(() => closure(storage.sql));
}
