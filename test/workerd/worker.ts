import { DurableObject } from 'cloudflare:workers';
import { Kysely, Migrator, sql, type Migration, type MigrationProvider } from 'kysely';
import { DurableObjectSqliteDialect } from '../../src/DurableObjectSqliteDialect.js';
import { withDoTransaction } from '../../src/withDoTransaction.js';
import {
  introspectSchema,
  generateKyselyDbInterface,
  type TableSchema,
} from '../../src/introspectSchema.js';

interface Env {
  TEST_DO: DurableObjectNamespace<TestDO>;
}

interface UserRow {
  id: number;
  name: string;
  email: string;
}

interface TypesRow {
  id: number;
  null_col: string | null;
  blob_col: Uint8Array | null;
  bigint_col: bigint | null;
  real_col: number | null;
  date_ms_col: number | null;
  json_text_col: string | null;
}

interface UserSchema {
  users: UserRow;
  types: TypesRow;
}

// Production workerd blocks dynamic code generation during request handling.
// The local test runner doesn't, so we patch in the same restriction to keep
// the dialect honest. Returns a restore function.
function patchEvalToThrow(): () => void {
  const OriginalFunction = globalThis.Function;
  const originalEval = globalThis.eval;

  const FunctionProxy = new Proxy(OriginalFunction, {
    construct() {
      throw new EvalError('Code generation from strings disallowed for this context');
    },
    apply() {
      throw new EvalError('Code generation from strings disallowed for this context');
    },
  });
  globalThis.Function = FunctionProxy as FunctionConstructor;
  globalThis.eval = () => {
    throw new EvalError('Code generation from strings disallowed for this context');
  };

  return () => {
    globalThis.Function = OriginalFunction;
    globalThis.eval = originalEval;
  };
}

export class TestDO extends DurableObject {
  private db: Kysely<UserSchema>;
  private restoreEval: (() => void) | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Kysely<UserSchema>({
      dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
    });
  }

  /** Patch Function/eval to throw EvalError for the rest of this DO's life. */
  async enableEvalGuard(): Promise<void> {
    if (!this.restoreEval) this.restoreEval = patchEvalToThrow();
  }

  async disableEvalGuard(): Promise<void> {
    if (this.restoreEval) {
      this.restoreEval();
      this.restoreEval = null;
    }
  }

  /** Returns 'eval-allowed' or 'eval-blocked' depending on the guard state. */
  async testEvalRestriction(): Promise<string> {
    try {
      new Function('return 1 + 1')();
      return 'eval-allowed';
    } catch (e: any) {
      if (e instanceof EvalError || e.message?.includes('Code generation from strings')) {
        return 'eval-blocked';
      }
      return `unexpected-error: ${e.message}`;
    }
  }

  async setupSchema(): Promise<void> {
    await this.db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('email', 'text', (col) => col.notNull())
      .execute();
  }

  async insertUser(name: string, email: string): Promise<UserRow> {
    return (await this.db
      .insertInto('users')
      .values({ name, email } as any)
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow()) as UserRow;
  }

  async getUser(id: number): Promise<UserRow | undefined> {
    return (await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as UserRow | undefined;
  }

  async getAllUsers(): Promise<UserRow[]> {
    return (await this.db.selectFrom('users').selectAll().execute()) as UserRow[];
  }

  async updateUser(id: number, name: string): Promise<void> {
    await this.db.updateTable('users').set({ name }).where('id', '=', id).execute();
  }

  async deleteUser(id: number): Promise<void> {
    await this.db.deleteFrom('users').where('id', '=', id).execute();
  }

  async destroyDb(): Promise<void> {
    await this.db.destroy();
  }

  async runTransactionExpectingThrow(): Promise<string> {
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('users')
          .values({ name: 'Tx1', email: 'tx1@example.com' } as any)
          .execute();
      });
      return 'no-throw';
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }

  async dialectCloneIsSelf(): Promise<boolean> {
    const dialect = new DurableObjectSqliteDialect(this.ctx.storage.sql);
    return dialect.clone() === dialect;
  }

  /**
   * Insert N rows then iterate them via the SqlStorageCursor returned by
   * sql.exec. Returns whether the cursor seems to lazily yield (rowsRead
   * grows during iteration) or eagerly buffer (rowsRead is N before
   * iteration starts).
   */
  /**
   * Time N inserts done through raw sql.exec vs through Kysely. Lets us pin
   * the Kysely overhead so it can be reported and regression-tested.
   */
  async benchmarkInsertOverhead(n: number): Promise<{
    raw: { ms: number; opsPerSec: number };
    kysely: { ms: number; opsPerSec: number };
    ratio: number;
  }> {
    const sqlH = this.ctx.storage.sql;

    // Raw path
    sqlH.exec('drop table if exists bench_raw');
    sqlH.exec(
      'create table bench_raw (id integer primary key autoincrement, name text not null, email text not null)',
    );
    const rawStart = performance.now();
    for (let i = 0; i < n; i++) {
      sqlH.exec(
        'insert into bench_raw (name, email) values (?, ?)',
        `n${i}`,
        `${i}@e`,
      );
    }
    const rawMs = performance.now() - rawStart;

    // Kysely path
    await this.db.schema
      .createTable('bench_k')
      .ifNotExists()
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('email', 'text', (c) => c.notNull())
      .execute();
    const kStart = performance.now();
    for (let i = 0; i < n; i++) {
      await (this.db as any)
        .insertInto('bench_k')
        .values({ name: `n${i}`, email: `${i}@e` })
        .execute();
    }
    const kMs = performance.now() - kStart;

    return {
      raw: { ms: rawMs, opsPerSec: (n / rawMs) * 1000 },
      kysely: { ms: kMs, opsPerSec: (n / kMs) * 1000 },
      ratio: kMs / rawMs,
    };
  }

  async cursorIsLazy(n: number): Promise<{
    rowsReadBeforeFirstNext: number;
    rowsReadAfterFirstNext: number;
    rowsReadAtEnd: number;
    total: number;
  }> {
    await this.setupSchema();
    for (let i = 0; i < n; i++) {
      await this.insertUser(`u${i}`, `${i}@e`);
    }
    const cursor = this.ctx.storage.sql.exec<{ id: number }>(
      'select id from users order by id',
    );
    const rowsReadBeforeFirstNext = cursor.rowsRead;
    const first = cursor.next();
    const rowsReadAfterFirstNext = cursor.rowsRead;
    let total = first.done ? 0 : 1;
    while (!cursor.next().done) total++;
    const rowsReadAtEnd = cursor.rowsRead;
    return {
      rowsReadBeforeFirstNext,
      rowsReadAfterFirstNext,
      rowsReadAtEnd,
      total,
    };
  }

  async streamRows(): Promise<{ count: number; names: string[] }> {
    await this.setupSchema();
    for (const n of ['A', 'B', 'C', 'D', 'E']) {
      await this.insertUser(n, `${n}@e`);
    }
    const names: string[] = [];
    const stream = this.db.selectFrom('users').select('name').stream();
    for await (const row of stream) {
      names.push((row as any).name);
    }
    return { count: names.length, names };
  }

  // ---------- schema introspection ----------

  async introspectAfterCreates(): Promise<TableSchema[]> {
    await this.setupSchema();
    await this.db.schema
      .createTable('orders')
      .ifNotExists()
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('user_id', 'integer', (c) => c.notNull())
      .addColumn('total_cents', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('memo', 'text')
      .execute();
    return introspectSchema(this.ctx.storage.sql);
  }

  async generateInterfaceFromSchema(): Promise<string> {
    await this.setupSchema();
    await this.db.schema
      .createTable('weird-name')
      .ifNotExists()
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .addColumn('full_name', 'text', (c) => c.notNull())
      .execute();
    const tables = introspectSchema(this.ctx.storage.sql);
    return generateKyselyDbInterface(tables);
  }

  // ---------- error paths ----------

  async attemptUniqueViolation(): Promise<string> {
    await this.db.schema
      .createTable('uniq')
      .ifNotExists()
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .addColumn('email', 'text', (c) => c.notNull().unique())
      .execute();
    await this.db
      .insertInto('uniq' as any)
      .values({ id: 1, email: 'a@e' } as any)
      .execute();
    try {
      await this.db
        .insertInto('uniq' as any)
        .values({ id: 2, email: 'a@e' } as any)
        .execute();
      return 'no-throw';
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }

  async attemptNotNullViolation(): Promise<string> {
    await this.setupSchema();
    try {
      await this.db
        .insertInto('users')
        .values({ name: null, email: 'x@e' } as any)
        .execute();
      return 'no-throw';
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }

  async attemptSyntaxError(): Promise<string> {
    try {
      await sql`this is not valid sql`.execute(this.db);
      return 'no-throw';
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }

  // ---------- UPSERT ----------

  async upsertOnConflict(): Promise<{
    afterInsert: { id: number; name: string; email: string };
    afterUpsert: { id: number; name: string; email: string };
    rowCount: number;
  }> {
    await this.setupSchema();
    const inserted = (await this.db
      .insertInto('users')
      .values({ name: 'Alice', email: 'a@e' } as any)
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow()) as UserRow;

    // INSERT ... ON CONFLICT(id) DO UPDATE — change name, keep id
    const upserted = (await this.db
      .insertInto('users')
      .values({ id: inserted.id, name: 'Alice (updated)', email: 'a@e' } as any)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ name: 'Alice (updated)' } as any),
      )
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow()) as UserRow;

    const all = await this.db.selectFrom('users').selectAll().execute();
    return { afterInsert: inserted, afterUpsert: upserted, rowCount: all.length };
  }

  // ---------- type fidelity ----------

  async setupTypesSchema(): Promise<void> {
    await this.db.schema
      .createTable('types')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('null_col', 'text')
      .addColumn('blob_col', 'blob')
      .addColumn('bigint_col', 'integer')
      .addColumn('real_col', 'real')
      .addColumn('date_ms_col', 'integer')
      .addColumn('json_text_col', 'text')
      .execute();
  }

  async roundtripNull(): Promise<TypesRow> {
    return (await this.db
      .insertInto('types')
      .values({
        null_col: null,
        blob_col: null,
        bigint_col: null,
        real_col: null,
        date_ms_col: null,
        json_text_col: null,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow()) as TypesRow;
  }

  async roundtripBlob(bytes: number[]): Promise<{
    sentLen: number;
    gotLen: number;
    sameBytes: boolean;
  }> {
    const sent = new Uint8Array(bytes);
    const result = await this.db
      .insertInto('types')
      .values({ blob_col: sent } as any)
      .returning(['id', 'blob_col'])
      .executeTakeFirstOrThrow();
    const got = (result as any).blob_col as Uint8Array | ArrayBuffer | null;
    const gotBytes = got instanceof Uint8Array ? got : new Uint8Array(got as ArrayBuffer);
    return {
      sentLen: sent.length,
      gotLen: gotBytes.length,
      sameBytes:
        gotBytes.length === sent.length && sent.every((b, i) => b === gotBytes[i]),
    };
  }

  async roundtripBigIntSafe(): Promise<{ sent: string; got: string }> {
    const sent = 1234567890123n;
    const result = await this.db
      .insertInto('types')
      .values({ bigint_col: sent } as any)
      .returning(['id', 'bigint_col'])
      .executeTakeFirstOrThrow();
    const got = (result as any).bigint_col as bigint | number;
    return {
      sent: sent.toString(),
      got: typeof got === 'bigint' ? got.toString() : String(got),
    };
  }

  async roundtripBigIntBeyondSafe(): Promise<{
    sent: string;
    readAsNumber: string;
    readAsCastText: string;
  }> {
    const sent = 9007199254740993n; // 2^53 + 1
    const inserted = await this.db
      .insertInto('types')
      .values({ bigint_col: sent } as any)
      .returning(['id', 'bigint_col'])
      .executeTakeFirstOrThrow();
    const id = (inserted as any).id as number;
    const cast = await sql<{ as_text: string }>`
      select cast(bigint_col as text) as as_text from types where id = ${id}
    `.execute(this.db);
    return {
      sent: sent.toString(),
      readAsNumber: String((inserted as any).bigint_col),
      readAsCastText: cast.rows[0]?.as_text ?? '',
    };
  }

  async roundtripReal(): Promise<{ sent: number; got: number }> {
    const sent = 3.141592653589793;
    const result = await this.db
      .insertInto('types')
      .values({ real_col: sent } as any)
      .returning(['id', 'real_col'])
      .executeTakeFirstOrThrow();
    return { sent, got: (result as any).real_col };
  }

  async roundtripDate(): Promise<{ sentMs: number; gotMs: number }> {
    const sentMs = new Date('2026-04-29T12:00:00.123Z').getTime();
    const result = await this.db
      .insertInto('types')
      .values({ date_ms_col: sentMs } as any)
      .returning(['id', 'date_ms_col'])
      .executeTakeFirstOrThrow();
    return { sentMs, gotMs: (result as any).date_ms_col };
  }

  async roundtripJson(): Promise<{ sent: string; got: string; extracted: string | null }> {
    const sent = JSON.stringify({ name: 'Alice', tags: ['a', 'b'], nested: { count: 3 } });
    const inserted = await this.db
      .insertInto('types')
      .values({ json_text_col: sent } as any)
      .returning(['id', 'json_text_col'])
      .executeTakeFirstOrThrow();
    const id = (inserted as any).id as number;
    const extracted = await sql<{ name: string }>`
      select json_extract(json_text_col, '$.name') as name from types where id = ${id}
    `.execute(this.db);
    return {
      sent,
      got: (inserted as any).json_text_col as string,
      extracted: extracted.rows[0]?.name ?? null,
    };
  }

  // ---------- migrations ----------

  async runKyselyMigrations(): Promise<{
    results: Array<{ migrationName: string; status: string }>;
    migrationTableHasRow: boolean;
    targetTableExists: boolean;
  }> {
    const provider: MigrationProvider = {
      async getMigrations(): Promise<Record<string, Migration>> {
        return {
          '2026_05_01_initial': {
            async up(db) {
              await db.schema
                .createTable('widget')
                .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
                .addColumn('name', 'text', (c) => c.notNull())
                .execute();
            },
          },
          '2026_05_02_add_color': {
            async up(db) {
              await db.schema.alterTable('widget').addColumn('color', 'text').execute();
            },
          },
        };
      },
    };

    const migrator = new Migrator({ db: this.db, provider });
    const { results, error } = await migrator.migrateToLatest();
    if (error) throw error;

    const tracking = await sql<{ count: number }>`
      select count(*) as count from kysely_migration
    `.execute(this.db);
    const schemaCheck = await sql<{ name: string }>`
      select name from sqlite_master where type = 'table' and name = 'widget'
    `.execute(this.db);

    return {
      results: (results ?? []).map((r) => ({
        migrationName: r.migrationName,
        status: r.status,
      })),
      migrationTableHasRow: (tracking.rows[0]?.count ?? 0) > 0,
      targetTableExists: schemaCheck.rows.length > 0,
    };
  }

  // ---------- withDoTransaction ----------

  async atomicBlockSucceeds(): Promise<{ before: number; after: number }> {
    const before = await this.userCount();
    withDoTransaction(this.ctx.storage, (s) => {
      s.exec("insert into users (name, email) values ('A1', 'a1@e')");
      s.exec("insert into users (name, email) values ('A2', 'a2@e')");
    });
    const after = await this.userCount();
    return { before, after };
  }

  async atomicBlockRollsBackOnThrow(): Promise<{
    before: number;
    after: number;
    caught: boolean;
  }> {
    const before = await this.userCount();
    let caught = false;
    try {
      withDoTransaction(this.ctx.storage, (s) => {
        s.exec("insert into users (name, email) values ('R1', 'r1@e')");
        s.exec("insert into users (name, email) values ('R2', 'r2@e')");
        throw new Error('rollback please');
      });
    } catch {
      caught = true;
    }
    const after = await this.userCount();
    return { before, after, caught };
  }

  // ---------- concurrency ----------

  async runRaceyConcurrent(n: number): Promise<{ rowCount: number; uniqueNames: number }> {
    await Promise.all(Array.from({ length: n }, () => this.raceyIncrement()));
    return this.summarizeUsers();
  }

  async runSafeConcurrent(n: number): Promise<{ rowCount: number; uniqueNames: number }> {
    await Promise.all(Array.from({ length: n }, () => this.safeIncrement()));
    return this.summarizeUsers();
  }

  // Read-modify-write across an await boundary: vulnerable to interleaving.
  private async raceyIncrement(): Promise<void> {
    const c = await this.userCount();
    await Promise.resolve();
    await this.db
      .insertInto('users')
      .values({ name: `inc-${c}`, email: `${c}@e` } as any)
      .execute();
  }

  // Same body, serialized by blockConcurrencyWhile.
  private async safeIncrement(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const c = await this.userCount();
      await Promise.resolve();
      await this.db
        .insertInto('users')
        .values({ name: `safe-${c}`, email: `${c}@e` } as any)
        .execute();
    });
  }

  private async userCount(): Promise<number> {
    const row = await this.db
      .selectFrom('users')
      .select(this.db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow();
    return Number(row.c);
  }

  private async summarizeUsers(): Promise<{ rowCount: number; uniqueNames: number }> {
    const all = await this.db.selectFrom('users').selectAll().execute();
    return {
      rowCount: all.length,
      uniqueNames: new Set(all.map((r) => (r as any).name)).size,
    };
  }
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    env.TEST_DO.idFromName('test'); // keep binding referenced
    return new Response('ok');
  },
};
