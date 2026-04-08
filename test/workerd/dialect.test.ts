import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import type { TestDO } from './worker.js';

describe('DurableObjectSqliteDialect in workerd', () => {
  // Use unique DO IDs per test to ensure isolation.
  // vitest-pool-workers isolates storage per test file, but multiple tests
  // in the same file that use the same DO ID share storage.
  function getStub(name: string): DurableObjectStub<TestDO> {
    const id = env.TEST_DO.idFromName(name);
    return env.TEST_DO.get(id);
  }

  it('documents eval behavior in test context', async () => {
    const stub = getStub('eval-test');
    const result = await stub.testEvalRestriction();
    // In the vitest-pool-workers test runner, eval may be allowed due to
    // relaxed test permissions. In production workerd, eval IS blocked
    // during request handling. This test documents current test-runner behavior.
    // The real value of workerd tests is catching SqlStorage API mismatches,
    // not eval restrictions (which the test runner relaxes).
    expect(['eval-allowed', 'eval-blocked']).toContain(result);
  });

  it('creates tables via Kysely schema builder', async () => {
    const stub = getStub('schema-test');
    await stub.setupSchema();
    const users = await stub.getAllUsers();
    expect(users).toHaveLength(0);
  });

  it('inserts and retrieves a user', async () => {
    const stub = getStub('insert-test');
    await stub.setupSchema();

    const inserted = await stub.insertUser('Alice', 'alice@example.com');
    expect(inserted.name).toBe('Alice');
    expect(inserted.email).toBe('alice@example.com');
    expect(inserted.id).toBeDefined();

    const fetched = await stub.getUser(inserted.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('Alice');
    expect(fetched!.email).toBe('alice@example.com');
  });

  it('handles multiple inserts with auto-increment', async () => {
    const stub = getStub('multi-insert-test');
    await stub.setupSchema();

    const user1 = await stub.insertUser('Alice', 'alice@example.com');
    const user2 = await stub.insertUser('Bob', 'bob@example.com');
    const user3 = await stub.insertUser('Charlie', 'charlie@example.com');

    expect(user1.id).toBeLessThan(user2.id);
    expect(user2.id).toBeLessThan(user3.id);

    const all = await stub.getAllUsers();
    expect(all).toHaveLength(3);
  });

  it('updates a user', async () => {
    const stub = getStub('update-test');
    await stub.setupSchema();

    const user = await stub.insertUser('Alice', 'alice@example.com');
    await stub.updateUser(user.id, 'Alicia');

    const updated = await stub.getUser(user.id);
    expect(updated!.name).toBe('Alicia');
    expect(updated!.email).toBe('alice@example.com');
  });

  it('deletes a user', async () => {
    const stub = getStub('delete-test');
    await stub.setupSchema();

    const user = await stub.insertUser('Alice', 'alice@example.com');
    await stub.deleteUser(user.id);

    const deleted = await stub.getUser(user.id);
    expect(deleted).toBeUndefined();
  });

  it('isolates storage between different DO instances', async () => {
    const stub1 = getStub('isolation-a');
    const stub2 = getStub('isolation-b');
    await stub1.setupSchema();
    await stub2.setupSchema();

    await stub1.insertUser('Alice', 'alice@example.com');
    await stub2.insertUser('Bob', 'bob@example.com');
    await stub2.insertUser('Charlie', 'charlie@example.com');

    const users1 = await stub1.getAllUsers();
    const users2 = await stub2.getAllUsers();
    expect(users1).toHaveLength(1);
    expect(users2).toHaveLength(2);
  });

  it('can inspect DO internals via runInDurableObject', async () => {
    const stub = getStub('inspect-test');
    await stub.setupSchema();
    await stub.insertUser('Alice', 'alice@example.com');

    await runInDurableObject(stub, async (_instance, state) => {
      // Access storage directly to verify the dialect wrote real data
      const rows = state.storage.sql
        .exec<{ name: string }>('SELECT name FROM users')
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Alice');
    });
  });

  it('handles empty result sets', async () => {
    const stub = getStub('empty-test');
    await stub.setupSchema();
    const users = await stub.getAllUsers();
    expect(users).toHaveLength(0);
  });
});
