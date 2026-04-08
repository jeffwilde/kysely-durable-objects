/**
 * Type definitions for Cloudflare Durable Object SQLite Storage API.
 *
 * These mirror the runtime types from `@cloudflare/workers-types` so that
 * this package can be used without a hard dependency on that package.
 */

/** A cursor returned by `SqlStorage.exec()`. */
export interface SqlStorageCursor<T = Record<string, unknown>> {
  toArray(): T[];
  one(): T;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  [Symbol.iterator](): IterableIterator<T>;
}

/** The `ctx.storage.sql` interface on a Durable Object. */
export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  readonly databaseSize: number;
}
