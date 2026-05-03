import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { TestDO } from './worker.js';

describe('DurableObjectSqliteDialect in workerd', () => {
  // Use unique DO IDs per test to ensure isolation.
  // vitest-pool-workers isolates storage per test file, but multiple tests
  // in the same file that use the same DO ID share storage.
  function getStub(name: string): DurableObjectStub<TestDO> {
    const id = env.TEST_DO.idFromName(name);
    return env.TEST_DO.get(id);
  }

  // ---------- eval guard tests ----------
  // These tests monkey-patch Function/eval inside the DO to simulate
  // production workerd restrictions where dynamic code generation throws EvalError.

  it('eval guard blocks new Function() inside the DO', async () => {
    const stub = getStub('eval-guard-verify');
    // Without the guard, eval is allowed in the test runner
    const before = await stub.testEvalRestriction();
    expect(before).toBe('eval-allowed');

    // Enable the guard — now eval should be blocked
    await stub.enableEvalGuard();
    const after = await stub.testEvalRestriction();
    expect(after).toBe('eval-blocked');

    // Restore
    await stub.disableEvalGuard();
    const restored = await stub.testEvalRestriction();
    expect(restored).toBe('eval-allowed');
  });

  it('dialect CRUD works with eval blocked (simulated production workerd)', async () => {
    const stub = getStub('eval-guarded-crud');
    await stub.setupSchema();
    await stub.enableEvalGuard();

    // INSERT
    const alice = await stub.insertUser('Alice', 'alice@example.com');
    expect(alice.name).toBe('Alice');
    expect(alice.id).toBeDefined();

    // SELECT
    const fetched = await stub.getUser(alice.id);
    expect(fetched).toBeDefined();
    expect(fetched!.email).toBe('alice@example.com');

    // UPDATE
    await stub.updateUser(alice.id, 'Alicia');
    const updated = await stub.getUser(alice.id);
    expect(updated!.name).toBe('Alicia');

    // DELETE
    await stub.deleteUser(alice.id);
    const deleted = await stub.getUser(alice.id);
    expect(deleted).toBeUndefined();

    // All CRUD succeeded without eval — dialect is eval-free
    await stub.disableEvalGuard();
  });

  it('multiple inserts with auto-increment work with eval blocked', async () => {
    const stub = getStub('eval-guarded-multi');
    await stub.setupSchema();
    await stub.enableEvalGuard();

    const user1 = await stub.insertUser('Alice', 'alice@example.com');
    const user2 = await stub.insertUser('Bob', 'bob@example.com');
    const user3 = await stub.insertUser('Charlie', 'charlie@example.com');

    expect(user1.id).toBeLessThan(user2.id);
    expect(user2.id).toBeLessThan(user3.id);

    const all = await stub.getAllUsers();
    expect(all).toHaveLength(3);

    await stub.disableEvalGuard();
  });

  // ---------- standard dialect tests (no eval guard) ----------

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

  it('destroy() does not throw', async () => {
    const stub = getStub('destroy-test');
    await stub.setupSchema();
    await stub.insertUser('Alice', 'alice@example.com');
    await expect(stub.destroyDb()).resolves.not.toThrow();
  });

  it('Kysely transactions throw with a clear error', async () => {
    const stub = getStub('transaction-test');
    await stub.setupSchema();

    const message = await stub.runTransactionExpectingThrow();
    expect(message).toMatch(/explicit transactions are not supported/i);
    expect(message).toMatch(/transactionSync/);

    // No partial writes — the BEGIN threw before any INSERT ran
    const all = await stub.getAllUsers();
    expect(all).toHaveLength(0);
  });

  it('clone() returns the same instance (MikroORM compatibility)', async () => {
    const stub = getStub('clone-test');
    expect(await stub.dialectCloneIsSelf()).toBe(true);
  });

  // ---------- type fidelity ----------

  describe('type fidelity', () => {
    it('roundtrips NULL across all column affinities', async () => {
      const stub = getStub('types-null');
      await stub.setupTypesSchema();
      const row = await stub.roundtripNull();
      expect(row.null_col).toBeNull();
      expect(row.blob_col).toBeNull();
      expect(row.bigint_col).toBeNull();
      expect(row.real_col).toBeNull();
      expect(row.date_ms_col).toBeNull();
      expect(row.json_text_col).toBeNull();
    });

    it('roundtrips BLOB (Uint8Array) bytes intact', async () => {
      const stub = getStub('types-blob');
      await stub.setupTypesSchema();
      const bytes = [0, 1, 2, 127, 128, 255, 0xde, 0xad, 0xbe, 0xef];
      const result = await stub.roundtripBlob(bytes);
      expect(result.gotLen).toBe(result.sentLen);
      expect(result.sameBytes).toBe(true);
    });

    it('roundtrips BigInt values within JS safe-integer range bit-exactly', async () => {
      const stub = getStub('types-bigint-safe');
      await stub.setupTypesSchema();
      const result = await stub.roundtripBigIntSafe();
      expect(result.got).toBe(result.sent);
    });

    it('preserves BigInt > 2^53 on write but loses precision on direct read; CAST AS TEXT recovers it', async () => {
      // Documents a hard limitation of DO storage: SqlStorageValue returns
      // INTEGER as JS Number, so values beyond 2^53 round on the read path.
      // The escape hatch is `CAST(col AS TEXT)` in SQL, which preserves the
      // full 64-bit value as a string.
      const stub = getStub('types-bigint-large');
      await stub.setupTypesSchema();
      const result = await stub.roundtripBigIntBeyondSafe();

      // Direct read DOES lose precision (rounds 2^53+1 down to 2^53)
      expect(result.readAsNumber).not.toBe(result.sent);
      expect(result.readAsNumber).toBe('9007199254740992');

      // CAST AS TEXT preserves full precision
      expect(result.readAsCastText).toBe(result.sent);
    });

    it('roundtrips REAL values without precision loss', async () => {
      const stub = getStub('types-real');
      await stub.setupTypesSchema();
      const result = await stub.roundtripReal();
      expect(result.got).toBe(result.sent);
    });

    it('roundtrips dates stored as integer ms', async () => {
      const stub = getStub('types-date');
      await stub.setupTypesSchema();
      const result = await stub.roundtripDate();
      expect(result.gotMs).toBe(result.sentMs);
      expect(new Date(result.gotMs).toISOString()).toBe(
        '2026-04-29T12:00:00.123Z',
      );
    });

    it('roundtrips JSON text and supports json_extract()', async () => {
      const stub = getStub('types-json');
      await stub.setupTypesSchema();
      const result = await stub.roundtripJson();
      expect(result.got).toBe(result.sent);
      expect(JSON.parse(result.got)).toEqual({
        name: 'Alice',
        tags: ['a', 'b'],
        nested: { count: 3 },
      });
      expect(result.extracted).toBe('Alice');
    });
  });

  // ---------- migrations ----------

  it("Kysely's Migrator runs against the dialect end-to-end", async () => {
    const stub = getStub('migrations-test');
    const result = await stub.runKyselyMigrations();

    expect(result.results.map((r) => r.status)).toEqual(['Success', 'Success']);
    expect(result.results.map((r) => r.migrationName)).toEqual([
      '2026_05_01_initial',
      '2026_05_02_add_color',
    ]);
    expect(result.migrationTableHasRow).toBe(true);
    expect(result.targetTableExists).toBe(true);
  });

  // ---------- withDoTransaction helper ----------

  describe('withDoTransaction', () => {
    it('commits all writes when the closure returns', async () => {
      const stub = getStub('atomic-commit');
      await stub.setupSchema();
      const counts = await stub.atomicBlockSucceeds();
      expect(counts.before).toBe(0);
      expect(counts.after).toBe(2);
    });

    it('rolls back all writes when the closure throws', async () => {
      const stub = getStub('atomic-rollback');
      await stub.setupSchema();
      const counts = await stub.atomicBlockRollsBackOnThrow();
      expect(counts.caught).toBe(true);
      expect(counts.before).toBe(0);
      // No writes from inside the failed closure should be visible
      expect(counts.after).toBe(0);
    });
  });

  // ---------- concurrency ----------

  describe('concurrency', () => {
    it('Kysely calls CAN interleave across await boundaries (lost-update without blockConcurrencyWhile)', async () => {
      // Demonstrates that DOs serialize storage *operations* but not async
      // *workflows*. Two requests calling read-modify-write concurrently can
      // both observe the same pre-update count, causing duplicate writes.
      const stub = getStub('concurrency-racey');
      await stub.setupSchema();
      const result = await stub.runRaceyConcurrent(5);
      expect(result.rowCount).toBe(5);
      // If interleaving happened, multiple workers saw the same `count` and
      // wrote duplicate names. We assert the *possibility* — uniqueNames
      // strictly less than rowCount proves the race.
      // (DO scheduling is deterministic-ish; we just assert >= 1 collision.)
      expect(result.uniqueNames).toBeLessThan(result.rowCount);
    });

    it('blockConcurrencyWhile serializes the workflow and prevents lost updates', async () => {
      const stub = getStub('concurrency-safe');
      await stub.setupSchema();
      const result = await stub.runSafeConcurrent(5);
      expect(result.rowCount).toBe(5);
      // Each call ran serially, so each saw a distinct count and wrote a
      // distinct name. No collisions.
      expect(result.uniqueNames).toBe(result.rowCount);
    });
  });
});
