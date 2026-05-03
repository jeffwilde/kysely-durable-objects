import { DurableObject } from 'cloudflare:workers';
import { Kysely } from 'kysely';
import { DurableObjectSqliteDialect, withDoTransaction } from 'kysely-durable-objects';

interface UserRow {
  id: number;
  name: string;
  email: string;
  created_at: number;
}

interface Schema {
  users: UserRow;
}

interface Env {
  USERS: DurableObjectNamespace<UserStore>;
}

export class UserStore extends DurableObject<Env> {
  private db: Kysely<Schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Kysely<Schema>({
      dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
    });

    ctx.blockConcurrencyWhile(async () => {
      await this.db.schema
        .createTable('users')
        .ifNotExists()
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text', (c) => c.notNull().unique())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .execute();
    });
  }

  async create(name: string, email: string): Promise<UserRow> {
    return (await this.db
      .insertInto('users')
      .values({ name, email, created_at: Date.now() } as any)
      .returningAll()
      .executeTakeFirstOrThrow()) as UserRow;
  }

  async list(): Promise<UserRow[]> {
    return (await this.db
      .selectFrom('users')
      .selectAll()
      .orderBy('id', 'asc')
      .execute()) as UserRow[];
  }

  /** Two writes that must land together — uses the atomicity escape hatch. */
  async swapEmails(idA: number, idB: number): Promise<void> {
    const [a, b] = await Promise.all([
      this.db.selectFrom('users').select('email').where('id', '=', idA).executeTakeFirstOrThrow(),
      this.db.selectFrom('users').select('email').where('id', '=', idB).executeTakeFirstOrThrow(),
    ]);

    withDoTransaction(this.ctx.storage, (sql) => {
      sql.exec('update users set email = ? where id = ?', a.email + '.tmp', idA);
      sql.exec('update users set email = ? where id = ?', b.email, idA);
      sql.exec('update users set email = ? where id = ?', a.email, idB);
    });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.USERS.get(env.USERS.idFromName('singleton'));

    if (req.method === 'POST' && url.pathname === '/users') {
      const body = (await req.json()) as { name: string; email: string };
      const user = await stub.create(body.name, body.email);
      return Response.json(user, { status: 201 });
    }

    if (req.method === 'GET' && url.pathname === '/users') {
      return Response.json(await stub.list());
    }

    return new Response('not found', { status: 404 });
  },
};
