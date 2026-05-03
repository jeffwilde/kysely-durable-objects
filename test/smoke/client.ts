// HTTP client for the smoke worker. Run after `wrangler deploy`:
//   SMOKE_URL=https://... SMOKE_TOKEN=... node --import tsx test/smoke/client.ts
const url = process.env.SMOKE_URL;
const token = process.env.SMOKE_TOKEN;

if (!url || !token) {
  console.error('SMOKE_URL and SMOKE_TOKEN must be set');
  process.exit(2);
}

const res = await fetch(`${url}/run?id=${crypto.randomUUID()}`, {
  headers: { authorization: `Bearer ${token}` },
});

const body = (await res.json()) as { ok: boolean; failures?: string[] };

if (res.status !== 200 || !body.ok) {
  console.error(`smoke FAIL (status ${res.status}):`);
  for (const f of body.failures ?? ['(no detail)']) console.error('  -', f);
  process.exit(1);
}

console.log(`smoke PASS (against ${url})`);
