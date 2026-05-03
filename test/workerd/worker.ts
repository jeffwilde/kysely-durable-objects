import { DurableObject } from 'cloudflare:workers';
import { Kysely, Migrator, sql, type Migration, type MigrationProvider } from 'kysely';
import { DurableObjectSqliteDialect } from '../../src/DurableObjectSqliteDialect.js';
import { withDoTransaction } from '../../src/withDoTransaction.js';

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

/**
 * Monkey-patches `Function` constructor and `eval` to throw `EvalError`,
 * simulating production workerd behavior where dynamic code generation
 * is prohibited during request handling.
 *
 * Returns a restore function to undo the patch.
 */
function patchEvalToThrow(): () => void {
  const OriginalFunction = globalThis.Function;
  const originalEval = globalThis.eval;

  // Proxy the Function constructor so `new Function(...)` throws EvalError.
  // We use a Proxy rather than a plain replacement so that `instanceof Function`
  // and other intrinsics still work for existing functions.
  const FunctionProxy = new Proxy(OriginalFunction, {
    construct(_target, args) {
      throw new EvalError(
        'Code generation from strings disallowed for this context',
      );
    },
    apply(_target, _thisArg, args) {
      throw new EvalError(
        'Code generation from strings disallowed for this context',
      );
    },
  });
  globalThis.Function = FunctionProxy as FunctionConstructor;

  globalThis.eval = () => {
    throw new EvalError(
      'Code generation from strings disallowed for this context',
    );
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

  /**
   * Enable the eval guard — patches Function/eval to throw EvalError.
   * All subsequent method calls on this DO instance will run with
   * eval blocked, simulating production workerd restrictions.
   */
  async enableEvalGuard(): Promise<void> {
    if (!this.restoreEval) {
      this.restoreEval = patchEvalToThrow();
    }
  }

  /** Disable the eval guard — restores original Function/eval. */
  async disableEvalGuard(): Promise<void> {
    if (this.restoreEval) {
      this.restoreEval();
      this.restoreEval = null;
    }
  }

  /** Returns 'eval-blocked' if the guard is active, 'eval-allowed' otherwise. */
  async testEvalRestriction(): Promise<string> {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return 1 + 1');
      fn();
      return 'eval-allowed';
    } catch (e: any) {
      if (
        e instanceof EvalError ||
        e.message?.includes('Code generation from strings')
      ) {
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
    const result = await this.db
      .insertInto('users')
      .values({ name, email } as any)
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow();
    return result as UserRow;
  }

  async getUser(id: number): Promise<UserRow | undefined> {
    return (await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as UserRow | undefined;
  }

  async getAllUsers(): Promise<UserRow[]> {
    return (await this.db
      .selectFrom('users')
      .selectAll()
      .execute()) as UserRow[];
  }

  async updateUser(id: number, name: string): Promise<void> {
    await this.db
      .updateTable('users')
      .set({ name })
      .where('id', '=', id)
      .execute();
  }

  async deleteUser(id: number): Promise<void> {
    await this.db
      .deleteFrom('users')
      .where('id', '=', id)
      .execute();
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
    const result = await this.db
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
      .executeTakeFirstOrThrow();
    return result as TypesRow;
  }

  async roundtripBlob(bytes: number[]): Promise<{
    sentLen: number;
    gotLen: number;
    isUint8Array: boolean;
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
    const sameBytes =
      gotBytes.length === sent.length &&
      sent.every((b, i) => b === gotBytes[i]);
    return {
      sentLen: sent.length,
      gotLen: gotBytes.length,
      isUint8Array: got instanceof Uint8Array || got instanceof ArrayBuffer,
      sameBytes,
    };
  }

  async roundtripBigIntSafe(): Promise<{ sent: string; got: string }> {
    // Within JS safe integer range — roundtrips bit-exact through Number
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
    storedAsText: string;
    readAsNumber: string;
    readAsCastText: string;
  }> {
    // Beyond JS safe-integer (2^53) — DO returns INTEGER as JS Number, so
    // direct reads lose precision. Casting to TEXT in SQL preserves it.
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
      storedAsText: sent.toString(),
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
    const date = new Date('2026-04-29T12:00:00.123Z');
    const sentMs = date.getTime();
    const result = await this.db
      .insertInto('types')
      .values({ date_ms_col: sentMs } as any)
      .returning(['id', 'date_ms_col'])
      .executeTakeFirstOrThrow();
    return { sentMs, gotMs: (result as any).date_ms_col };
  }

  async roundtripJson(): Promise<{
    sent: string;
    got: string;
    extracted: string | null;
  }> {
    const obj = { name: 'Alice', tags: ['a', 'b'], nested: { count: 3 } };
    const sent = JSON.stringify(obj);
    const inserted = await this.db
      .insertInto('types')
      .values({ json_text_col: sent } as any)
      .returning(['id', 'json_text_col'])
      .executeTakeFirstOrThrow();
    // Also exercise SQLite's json_extract via raw sql template
    const idVal = (inserted as any).id as number;
    const extractRow = await sql<{ name: string }>`
      select json_extract(json_text_col, '$.name') as name
      from types where id = ${idVal}
    `.execute(this.db);
    return {
      sent,
      got: (inserted as any).json_text_col as string,
      extracted: extractRow.rows[0]?.name ?? null,
    };
  }

  // ---------- Kysely migrations ----------

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
              await db.schema
                .alterTable('widget')
                .addColumn('color', 'text')
                .execute();
            },
          },
        };
      },
    };

    const migrator = new Migrator({ db: this.db, provider });
    const { results, error } = await migrator.migrateToLatest();
    if (error) throw error;

    // Verify Kysely's migration tracking table is populated
    const tracking = await sql<{ count: number }>`
      select count(*) as count from kysely_migration
    `.execute(this.db);
    const migrationTableHasRow = (tracking.rows[0]?.count ?? 0) > 0;

    // Verify the target schema actually got created
    const schemaCheck = await sql<{ name: string }>`
      select name from sqlite_master where type = 'table' and name = 'widget'
    `.execute(this.db);
    const targetTableExists = schemaCheck.rows.length > 0;

    return {
      results: (results ?? []).map((r) => ({
        migrationName: r.migrationName,
        status: r.status,
      })),
      migrationTableHasRow,
      targetTableExists,
    };
  }

  // ---------- withDoTransaction helper ----------

  async atomicBlockSucceeds(): Promise<{ before: number; after: number }> {
    // Two raw INSERTs inside a single transactionSync — both should land
    const before = await this.db
      .selectFrom('users')
      .select(this.db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow();
    withDoTransaction(this.ctx.storage, (s) => {
      s.exec("insert into users (name, email) values ('A1', 'a1@e')");
      s.exec("insert into users (name, email) values ('A2', 'a2@e')");
    });
    const after = await this.db
      .selectFrom('users')
      .select(this.db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow();
    return { before: Number(before.c), after: Number(after.c) };
  }

  // ---------- concurrency ----------

  /**
   * Reads count, awaits a microtask, then increments. Without
   * blockConcurrencyWhile, two concurrent calls can interleave at the await
   * boundary and lose an update (lost-update). Used to demonstrate that
   * Kysely-on-DO is NOT immune to interleaving across await points.
   */
  async raceyIncrement(): Promise<void> {
    const row = await this.db
      .selectFrom('users')
      .select(this.db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow();
    // Force a microtask boundary so two concurrent calls can interleave
    await Promise.resolve();
    await this.db
      .insertInto('users')
      .values({ name: `inc-${Number(row.c)}`, email: `${Number(row.c)}@e` } as any)
      .execute();
  }

  /**
   * Same logic as raceyIncrement, but the entire body runs inside
   * blockConcurrencyWhile, which serializes against other requests.
   */
  async safeIncrement(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const row = await this.db
        .selectFrom('users')
        .select(this.db.fn.count<number>('id').as('c'))
        .executeTakeFirstOrThrow();
      await Promise.resolve();
      await this.db
        .insertInto('users')
        .values({ name: `safe-${Number(row.c)}`, email: `${Number(row.c)}@e` } as any)
        .execute();
    });
  }

  async runRaceyConcurrent(n: number): Promise<{ rowCount: number; uniqueNames: number }> {
    await Promise.all(Array.from({ length: n }, () => this.raceyIncrement()));
    return this.summarizeConcurrencyState();
  }

  async runSafeConcurrent(n: number): Promise<{ rowCount: number; uniqueNames: number }> {
    await Promise.all(Array.from({ length: n }, () => this.safeIncrement()));
    return this.summarizeConcurrencyState();
  }

  private async summarizeConcurrencyState(): Promise<{
    rowCount: number;
    uniqueNames: number;
  }> {
    const all = await this.db.selectFrom('users').selectAll().execute();
    const names = new Set(all.map((r) => (r as any).name));
    return { rowCount: all.length, uniqueNames: names.size };
  }

  async atomicBlockRollsBackOnThrow(): Promise<{
    before: number;
    after: number;
    caught: boolean;
  }> {
    const before = await this.db
      .selectFrom('users')
      .select(this.db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow();
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
    const after = await this.db
      .selectFrom('users')
      .select(this.db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow();
    return { before: Number(before.c), after: Number(after.c), caught };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.TEST_DO.idFromName('test');
    const stub = env.TEST_DO.get(id);
    return new Response('ok');
  },
};
