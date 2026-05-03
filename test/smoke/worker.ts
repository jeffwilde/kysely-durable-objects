// Smoke-test worker — deployed to real Cloudflare and exercised over HTTP by
// `client.ts`. Runs a focused subset of the local workerd suite to catch
// divergences between local and production runtime behavior.
import { DurableObject } from 'cloudflare:workers';
import { Kysely, sql } from 'kysely';
import { DurableObjectSqliteDialect, withDoTransaction } from '../../src/index.js';

interface Schema {
  users: { id: number; name: string; email: string };
}

interface Env {
  SMOKE_DO: DurableObjectNamespace<SmokeDO>;
}

export class SmokeDO extends DurableObject<Env> {
  private db: Kysely<Schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Kysely<Schema>({
      dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
    });
  }

  async run(): Promise<{ ok: true } | { ok: false; failures: string[] }> {
    const failures: string[] = [];
    const expect = (cond: boolean, msg: string) => {
      if (!cond) failures.push(msg);
    };

    await this.db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('email', 'text', (c) => c.notNull().unique())
      .execute();

    // CRUD + RETURNING + insertId
    const u = await this.db
      .insertInto('users')
      .values({ name: 'Alice', email: 'alice@e' } as any)
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow();
    expect(typeof (u as any).id === 'number', 'insertId should be a number');
    expect((u as any).name === 'Alice', 'returning name should be Alice');

    // Transaction throw
    let threw = false;
    try {
      await this.db.transaction().execute(async () => {});
    } catch {
      threw = true;
    }
    expect(threw, 'db.transaction() must throw on the dialect');

    // withDoTransaction commit
    withDoTransaction(this.ctx.storage, (s) => {
      s.exec("insert into users (name, email) values ('Bob', 'bob@e')");
      s.exec("insert into users (name, email) values ('Carol', 'carol@e')");
    });
    const after = await this.db.selectFrom('users').selectAll().execute();
    expect(after.length === 3, `expected 3 users after commit, got ${after.length}`);

    // BigInt parameter coercion
    await this.db.schema
      .createTable('big')
      .ifNotExists()
      .addColumn('v', 'integer')
      .execute();
    await this.db
      .insertInto('big' as any)
      .values({ v: 1234567890123n } as any)
      .execute();
    const big = await sql<{ as_text: string }>`
      select cast(v as text) as as_text from big
    `.execute(this.db);
    expect(
      big.rows[0]?.as_text === '1234567890123',
      `bigint roundtrip via CAST AS TEXT mismatch: ${big.rows[0]?.as_text}`,
    );

    // UPSERT
    await this.db
      .insertInto('users')
      .values({ id: 1, name: 'Alice2', email: 'alice@e' } as any)
      .onConflict((oc) => oc.column('id').doUpdateSet({ name: 'Alice2' } as any))
      .execute();
    const updated = await this.db
      .selectFrom('users')
      .select('name')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect((updated as any).name === 'Alice2', 'UPSERT should have updated name to Alice2');

    return failures.length === 0 ? { ok: true } : { ok: false, failures };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/run') return new Response('not found', { status: 404 });

    // Require a token to gate the endpoint — set as SMOKE_TOKEN secret
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const expected = (env as any).SMOKE_TOKEN as string | undefined;
    if (!expected || token !== expected) {
      return new Response('forbidden', { status: 403 });
    }

    // Each test run uses a unique DO to start from a clean slate
    const id = url.searchParams.get('id') ?? crypto.randomUUID();
    const stub = env.SMOKE_DO.get(env.SMOKE_DO.idFromName(id));
    const result = await stub.run();
    return Response.json(result, { status: result.ok ? 200 : 500 });
  },
};
