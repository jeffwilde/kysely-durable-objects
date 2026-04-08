import { DurableObject } from 'cloudflare:workers';
import { Kysely } from 'kysely';
import { DurableObjectSqliteDialect } from '../../src/DurableObjectSqliteDialect.js';

interface Env {
  TEST_DO: DurableObjectNamespace<TestDO>;
}

interface UserRow {
  id: number;
  name: string;
  email: string;
}

interface UserSchema {
  users: UserRow;
}

export class TestDO extends DurableObject {
  private db: Kysely<UserSchema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Kysely<UserSchema>({
      dialect: new DurableObjectSqliteDialect(ctx.storage.sql),
    });
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
    return await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst() as UserRow | undefined;
  }

  async getAllUsers(): Promise<UserRow[]> {
    return await this.db
      .selectFrom('users')
      .selectAll()
      .execute() as UserRow[];
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

  async testEvalRestriction(): Promise<string> {
    // Verify that new Function() is blocked in the DO context.
    // This is the exact restriction that compiledFunctions is designed to work around.
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return 1 + 1');
      fn();
      return 'eval-allowed';
    } catch (e: any) {
      if (e instanceof EvalError || e.message?.includes('Code generation from strings')) {
        return 'eval-blocked';
      }
      return `unexpected-error: ${e.message}`;
    }
  }

}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.TEST_DO.idFromName('test');
    const stub = env.TEST_DO.get(id);
    return new Response('ok');
  },
};
