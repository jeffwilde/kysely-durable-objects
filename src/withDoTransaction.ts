import type { SqlStorage } from './types.js';

export interface DurableObjectStorageLike {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

/**
 * Atomic block of synchronous raw SQL against `ctx.storage.sql`. Wraps
 * `storage.transactionSync()`; throwing inside the closure rolls back.
 *
 * The closure must be synchronous — that's a hard constraint of `transactionSync`.
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
 */
export function withDoTransaction<T>(
  storage: DurableObjectStorageLike,
  closure: (sql: SqlStorage) => T,
): T {
  return storage.transactionSync(() => closure(storage.sql));
}
