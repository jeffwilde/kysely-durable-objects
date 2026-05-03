import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { TestDO } from './worker.js';

describe('DurableObjectSqliteDialect in workerd', () => {
  function getStub(name: string): DurableObjectStub<TestDO> {
    return env.TEST_DO.get(env.TEST_DO.idFromName(name));
  }

  describe('eval guard (production parity)', () => {
    it('blocks new Function() inside the DO when the guard is on', async () => {
      const stub = getStub('eval-guard-verify');
      expect(await stub.testEvalRestriction()).toBe('eval-allowed');
      await stub.enableEvalGuard();
      expect(await stub.testEvalRestriction()).toBe('eval-blocked');
      await stub.disableEvalGuard();
      expect(await stub.testEvalRestriction()).toBe('eval-allowed');
    });

    it('full CRUD succeeds with eval blocked', async () => {
      const stub = getStub('eval-guarded-crud');
      await stub.setupSchema();
      await stub.enableEvalGuard();

      const alice = await stub.insertUser('Alice', 'alice@example.com');
      expect(alice.name).toBe('Alice');
      expect((await stub.getUser(alice.id))!.email).toBe('alice@example.com');

      await stub.updateUser(alice.id, 'Alicia');
      expect((await stub.getUser(alice.id))!.name).toBe('Alicia');

      await stub.deleteUser(alice.id);
      expect(await stub.getUser(alice.id)).toBeUndefined();

      await stub.disableEvalGuard();
    });

    it('multiple inserts auto-increment correctly with eval blocked', async () => {
      const stub = getStub('eval-guarded-multi');
      await stub.setupSchema();
      await stub.enableEvalGuard();

      const u1 = await stub.insertUser('Alice', 'alice@example.com');
      const u2 = await stub.insertUser('Bob', 'bob@example.com');
      const u3 = await stub.insertUser('Charlie', 'charlie@example.com');

      expect(u1.id).toBeLessThan(u2.id);
      expect(u2.id).toBeLessThan(u3.id);
      expect(await stub.getAllUsers()).toHaveLength(3);

      await stub.disableEvalGuard();
    });
  });

  describe('CRUD', () => {
    it('creates tables via Kysely schema builder', async () => {
      const stub = getStub('schema-test');
      await stub.setupSchema();
      expect(await stub.getAllUsers()).toHaveLength(0);
    });

    it('inserts and retrieves a user', async () => {
      const stub = getStub('insert-test');
      await stub.setupSchema();
      const inserted = await stub.insertUser('Alice', 'alice@example.com');
      const fetched = await stub.getUser(inserted.id);
      expect(fetched).toEqual(inserted);
    });

    it('handles multiple inserts with auto-increment', async () => {
      const stub = getStub('multi-insert-test');
      await stub.setupSchema();
      const u1 = await stub.insertUser('Alice', 'a@e');
      const u2 = await stub.insertUser('Bob', 'b@e');
      const u3 = await stub.insertUser('Charlie', 'c@e');
      expect(u1.id).toBeLessThan(u2.id);
      expect(u2.id).toBeLessThan(u3.id);
      expect(await stub.getAllUsers()).toHaveLength(3);
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
      expect(await stub.getUser(user.id)).toBeUndefined();
    });

    it('isolates storage between different DO instances', async () => {
      const a = getStub('isolation-a');
      const b = getStub('isolation-b');
      await a.setupSchema();
      await b.setupSchema();
      await a.insertUser('Alice', 'a@e');
      await b.insertUser('Bob', 'b@e');
      await b.insertUser('Charlie', 'c@e');
      expect(await a.getAllUsers()).toHaveLength(1);
      expect(await b.getAllUsers()).toHaveLength(2);
    });

    it('inspects DO internals via runInDurableObject', async () => {
      const stub = getStub('inspect-test');
      await stub.setupSchema();
      await stub.insertUser('Alice', 'alice@example.com');

      await runInDurableObject(stub, async (_inst, state) => {
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
      expect(await stub.getAllUsers()).toHaveLength(0);
    });

    it('destroy() does not throw', async () => {
      const stub = getStub('destroy-test');
      await stub.setupSchema();
      await stub.insertUser('Alice', 'alice@example.com');
      await expect(stub.destroyDb()).resolves.not.toThrow();
    });
  });

  describe('transactions', () => {
    it('throw with a clear error pointing to transactionSync', async () => {
      const stub = getStub('transaction-test');
      await stub.setupSchema();
      const message = await stub.runTransactionExpectingThrow();
      expect(message).toMatch(/explicit transactions are not supported/i);
      expect(message).toMatch(/transactionSync/);
      expect(await stub.getAllUsers()).toHaveLength(0);
    });
  });

  describe('clone()', () => {
    it('returns the same instance (MikroORM Utils.copy compatibility)', async () => {
      const stub = getStub('clone-test');
      expect(await stub.dialectCloneIsSelf()).toBe(true);
    });
  });

  describe('error paths', () => {
    it('UNIQUE constraint violations surface a real error', async () => {
      const stub = getStub('error-unique');
      const message = await stub.attemptUniqueViolation();
      expect(message).not.toBe('no-throw');
      expect(message.toLowerCase()).toMatch(/unique|constraint/);
    });

    it('NOT NULL constraint violations surface a real error', async () => {
      const stub = getStub('error-notnull');
      const message = await stub.attemptNotNullViolation();
      expect(message).not.toBe('no-throw');
      expect(message.toLowerCase()).toMatch(/not null|constraint/);
    });

    it('SQL syntax errors surface a real error', async () => {
      const stub = getStub('error-syntax');
      await stub.setupSchema();
      const message = await stub.attemptSyntaxError();
      expect(message).not.toBe('no-throw');
      expect(message.toLowerCase()).toMatch(/syntax|near/);
    });
  });

  describe('UPSERT', () => {
    it('INSERT ... ON CONFLICT DO UPDATE works with RETURNING', async () => {
      const stub = getStub('upsert-test');
      const result = await stub.upsertOnConflict();
      expect(result.afterInsert.name).toBe('Alice');
      expect(result.afterUpsert.id).toBe(result.afterInsert.id);
      expect(result.afterUpsert.name).toBe('Alice (updated)');
      expect(result.rowCount).toBe(1);
    });
  });

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
      const result = await stub.roundtripBlob([0, 1, 2, 127, 128, 255, 0xde, 0xad, 0xbe, 0xef]);
      expect(result.gotLen).toBe(result.sentLen);
      expect(result.sameBytes).toBe(true);
    });

    it('roundtrips BigInt within JS safe-integer range bit-exactly', async () => {
      const stub = getStub('types-bigint-safe');
      await stub.setupTypesSchema();
      const result = await stub.roundtripBigIntSafe();
      expect(result.got).toBe(result.sent);
    });

    it('preserves BigInt > 2^53 on write; direct read rounds, CAST AS TEXT recovers', async () => {
      // DO returns INTEGER as JS Number, so reads beyond 2^53 round.
      const stub = getStub('types-bigint-large');
      await stub.setupTypesSchema();
      const result = await stub.roundtripBigIntBeyondSafe();
      expect(result.readAsNumber).toBe('9007199254740992');
      expect(result.readAsCastText).toBe(result.sent);
    });

    it('roundtrips REAL without precision loss', async () => {
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
      expect(new Date(result.gotMs).toISOString()).toBe('2026-04-29T12:00:00.123Z');
    });

    it('roundtrips JSON text and supports json_extract()', async () => {
      const stub = getStub('types-json');
      await stub.setupTypesSchema();
      const result = await stub.roundtripJson();
      expect(JSON.parse(result.got)).toEqual({
        name: 'Alice',
        tags: ['a', 'b'],
        nested: { count: 3 },
      });
      expect(result.extracted).toBe('Alice');
    });
  });

  describe('Kysely Migrator', () => {
    it('runs migrations end-to-end and tracks them in kysely_migration', async () => {
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
  });

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
      expect(counts.after).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('async workflows can interleave at await boundaries (lost-update)', async () => {
      const stub = getStub('concurrency-racey');
      await stub.setupSchema();
      const result = await stub.runRaceyConcurrent(5);
      expect(result.rowCount).toBe(5);
      expect(result.uniqueNames).toBeLessThan(result.rowCount);
    });

    it('blockConcurrencyWhile serializes the workflow and prevents lost updates', async () => {
      const stub = getStub('concurrency-safe');
      await stub.setupSchema();
      const result = await stub.runSafeConcurrent(5);
      expect(result.rowCount).toBe(5);
      expect(result.uniqueNames).toBe(result.rowCount);
    });
  });
});
