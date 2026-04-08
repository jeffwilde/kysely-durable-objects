import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Kysely } from 'kysely';
import { DurableObjectSqliteDialect } from '../../src/DurableObjectSqliteDialect.js';
import type { SqlStorage, SqlStorageCursor } from '../../src/types.js';

/** Minimal mock of DO SqlStorage for unit testing. */
function createMockSqlStorage(): SqlStorage & { _tables: Map<string, unknown[]> } {
  // In-memory store keyed by table name — just enough to test the dialect bridge.
  // Real integration testing happens in the workerd suite.
  const execResults: unknown[][] = [];
  let lastInsertRowid = 0;
  let lastChanges = 0;

  function makeCursor<T>(rows: T[]): SqlStorageCursor<T> {
    return {
      toArray: () => [...rows],
      one: () => {
        if (rows.length === 0) {
          throw new Error('Expected exactly one row, got 0');
        }
        return rows[0];
      },
      columnNames: rows.length > 0 ? Object.keys(rows[0] as object) : [],
      rowsRead: rows.length,
      rowsWritten: 0,
      [Symbol.iterator]: function* () {
        yield* rows;
      },
    };
  }

  const storage = {
    _tables: new Map<string, unknown[]>(),
    _lastInsertRowid: 0,
    _lastChanges: 0,

    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursor<T> {
      const trimmed = query.trim().toLowerCase();

      // Handle the metadata queries the dialect uses internally
      if (trimmed === 'select changes() as c') {
        return makeCursor([{ c: storage._lastChanges }]) as SqlStorageCursor<T>;
      }
      if (trimmed === 'select last_insert_rowid() as id') {
        return makeCursor([{ id: storage._lastInsertRowid }]) as SqlStorageCursor<T>;
      }

      // Handle CREATE TABLE
      if (trimmed.startsWith('create table')) {
        const match = query.match(/create table\s+(?:if not exists\s+)?["`]?(\w+)["`]?/i);
        if (match) {
          storage._tables.set(match[1], []);
        }
        storage._lastChanges = 0;
        return makeCursor([]) as SqlStorageCursor<T>;
      }

      // Handle INSERT
      if (trimmed.startsWith('insert into')) {
        const match = query.match(/insert into\s+["`]?(\w+)["`]?/i);
        if (match) {
          const table = storage._tables.get(match[1]) ?? [];
          // Extract column names from the query
          const colMatch = query.match(/\(([^)]+)\)\s+values/i);
          if (colMatch) {
            const cols = colMatch[1].split(',').map((c) => c.trim().replace(/["`]/g, ''));
            const row: Record<string, unknown> = {};
            cols.forEach((col, i) => {
              row[col] = bindings[i];
            });
            // Auto-increment ID for integer primary keys
            if (!row['id']) {
              storage._lastInsertRowid++;
              row['id'] = storage._lastInsertRowid;
            } else {
              storage._lastInsertRowid = Number(row['id']);
            }
            table.push(row);
            storage._tables.set(match[1], table);
          }
          storage._lastChanges = 1;

          // Handle RETURNING
          if (/\breturning\b/i.test(query)) {
            return makeCursor([table[table.length - 1]]) as SqlStorageCursor<T>;
          }
        }
        return makeCursor([]) as SqlStorageCursor<T>;
      }

      // Handle SELECT
      if (trimmed.startsWith('select')) {
        const match = query.match(/from\s+["`]?(\w+)["`]?/i);
        if (match) {
          let rows = [...(storage._tables.get(match[1]) ?? [])];

          // Basic WHERE clause support
          const whereMatch = query.match(/where\s+["`]?(\w+)["`]?\s*=\s*\?/i);
          if (whereMatch && bindings.length > 0) {
            const col = whereMatch[1];
            rows = rows.filter((r: any) => r[col] === bindings[0]);
          }

          return makeCursor(rows) as SqlStorageCursor<T>;
        }
        return makeCursor([]) as SqlStorageCursor<T>;
      }

      // Handle UPDATE
      if (trimmed.startsWith('update')) {
        const match = query.match(/update\s+["`]?(\w+)["`]?/i);
        if (match) {
          const table = storage._tables.get(match[1]) ?? [];
          // Simplified: update all rows
          storage._lastChanges = table.length;
        }
        return makeCursor([]) as SqlStorageCursor<T>;
      }

      // Handle DELETE
      if (trimmed.startsWith('delete')) {
        const match = query.match(/from\s+["`]?(\w+)["`]?/i);
        if (match) {
          const table = storage._tables.get(match[1]) ?? [];
          const whereMatch = query.match(/where\s+["`]?(\w+)["`]?\s*=\s*\?/i);
          if (whereMatch && bindings.length > 0) {
            const col = whereMatch[1];
            const before = table.length;
            const filtered = table.filter((r: any) => r[col] !== bindings[0]);
            storage._tables.set(match[1], filtered);
            storage._lastChanges = before - filtered.length;
          } else {
            storage._lastChanges = table.length;
            storage._tables.set(match[1], []);
          }
        }
        return makeCursor([]) as SqlStorageCursor<T>;
      }

      // Handle PRAGMA and other statements
      storage._lastChanges = 0;
      return makeCursor([]) as SqlStorageCursor<T>;
    },

    get databaseSize(): number {
      return 4096; // Stub
    },
  };

  return storage as SqlStorage & { _tables: Map<string, unknown[]> };
}

// Schema type for Kysely
interface TestSchema {
  users: {
    id: number;
    name: string;
    email: string;
  };
}

describe('DurableObjectSqliteDialect', () => {
  let sql: ReturnType<typeof createMockSqlStorage>;
  let db: Kysely<TestSchema>;

  beforeEach(() => {
    sql = createMockSqlStorage();
    db = new Kysely<TestSchema>({
      dialect: new DurableObjectSqliteDialect(sql),
    });
  });

  it('creates a valid Kysely instance', () => {
    expect(db).toBeDefined();
    expect(db).toBeInstanceOf(Kysely);
  });

  it('executes raw CREATE TABLE', async () => {
    await db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('email', 'text', (col) => col.notNull())
      .execute();

    expect(sql._tables.has('users')).toBe(true);
  });

  it('inserts and selects rows', async () => {
    // Setup table
    sql._tables.set('users', []);

    const result = await db
      .insertInto('users')
      .values({ id: 1, name: 'Alice', email: 'alice@example.com' })
      .execute();

    expect(result).toBeDefined();

    const rows = await db.selectFrom('users').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Alice');
    expect(rows[0].email).toBe('alice@example.com');
  });

  it('handles SELECT with WHERE clause', async () => {
    sql._tables.set('users', [
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
    ]);

    const rows = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', 1)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Alice');
  });

  it('handles DELETE', async () => {
    sql._tables.set('users', [
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
    ]);

    await db.deleteFrom('users').where('id', '=', 1).execute();

    const remaining = sql._tables.get('users')!;
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as any).name).toBe('Bob');
  });

  it('retrieves changes and lastInsertRowid via SQLite functions', async () => {
    sql._tables.set('users', []);

    // Insert triggers the changes() and last_insert_rowid() queries
    const execSpy = vi.spyOn(sql, 'exec');

    await db
      .insertInto('users')
      .values({ id: 42, name: 'Charlie', email: 'charlie@example.com' })
      .execute();

    // The dialect should have called exec for the INSERT,
    // then 'select changes() as c' and 'select last_insert_rowid() as id'
    const calls = execSpy.mock.calls.map((c) => c[0].trim().toLowerCase());
    expect(calls).toContain('select changes() as c');
    expect(calls).toContain('select last_insert_rowid() as id');
  });

  it('close() is a no-op (does not throw)', async () => {
    // Destroying the Kysely instance calls close() on the database
    await expect(db.destroy()).resolves.not.toThrow();
  });

  it('handles empty result sets', async () => {
    sql._tables.set('users', []);

    const rows = await db.selectFrom('users').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});

describe('SqlStorage mock cursor', () => {
  it('toArray returns all rows', () => {
    const sql = createMockSqlStorage();
    sql._tables.set('items', [{ id: 1 }, { id: 2 }]);
    const cursor = sql.exec('select * from items');
    expect(cursor.toArray()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('one() returns first row', () => {
    const sql = createMockSqlStorage();
    sql._tables.set('items', [{ id: 1 }]);
    const cursor = sql.exec('select * from items');
    expect(cursor.one()).toEqual({ id: 1 });
  });

  it('one() throws on empty result', () => {
    const sql = createMockSqlStorage();
    sql._tables.set('items', []);
    const cursor = sql.exec('select * from items');
    expect(() => cursor.one()).toThrow('Expected exactly one row');
  });

  it('iterator yields rows', () => {
    const sql = createMockSqlStorage();
    sql._tables.set('items', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const cursor = sql.exec('select * from items');
    const collected = [...cursor];
    expect(collected).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});
