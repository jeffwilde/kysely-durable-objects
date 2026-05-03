# basic-worker

Minimal example: a Cloudflare Worker with a single Durable Object using `kysely-durable-objects`.

## Run locally

```bash
pnpm install
pnpm dev
```

Then in another terminal:

```bash
curl -X POST http://localhost:8787/users -d '{"name":"Alice","email":"alice@example.com"}' -H 'content-type: application/json'
curl http://localhost:8787/users
```

## What it shows

- Constructing a `Kysely` instance over `ctx.storage.sql` via `DurableObjectSqliteDialect`
- One-time schema creation under `blockConcurrencyWhile` in the DO constructor
- INSERT with `RETURNING`
- An atomic block via `withDoTransaction` that does a read-then-two-writes that must commit together

## Deploy

```bash
pnpm deploy
```
