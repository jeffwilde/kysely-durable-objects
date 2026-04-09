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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.TEST_DO.idFromName('test');
    const stub = env.TEST_DO.get(id);
    return new Response('ok');
  },
};
