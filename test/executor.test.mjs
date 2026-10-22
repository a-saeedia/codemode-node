import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeExecutor } from '../src/executor.mjs';

const ex = new NodeExecutor({ timeout: 5000 });

test('returns the value of an async arrow function', async () => {
  const out = await ex.execute('async () => 6 * 7', []);
  assert.equal(out.error, undefined);
  assert.equal(out.result, 42);
});

test('supports statement bodies (implicit async IIFE)', async () => {
  const out = await ex.execute('const a = 20; return a + 22;', []);
  assert.equal(out.result, 42);
});

test('exposes providers as namespaces taking a single object arg', async () => {
  const calls = [];
  const out = await ex.execute(
    "async () => (await tools.upper({ s: 'ok' })) + '!'",
    [{ name: 'tools', fns: { upper: ({ s }) => s.toUpperCase() } }],
  );
  assert.equal(out.result, 'OK!');
});

test('accepts a map of providers as well as an array', async () => {
  const out = await ex.execute('async () => await m.add({ a: 1, b: 2 })', {
    m: { add: ({ a, b }) => a + b },
  });
  assert.equal(out.result, 3);
});

test('awaits async host functions', async () => {
  const out = await ex.execute('async () => await m.slow()', {
    m: { slow: async () => { await new Promise((r) => setTimeout(r, 20)); return 'done'; } },
  });
  assert.equal(out.result, 'done');
});

test('host errors surface as {error}, not a throw', async () => {
  const out = await ex.execute('async () => await m.boom()', {
    m: { boom: () => { throw new Error('kaboom'); } },
  });
  assert.equal(out.result, undefined);
  assert.match(out.error, /kaboom/);
});

test('sandbox runtime errors surface as {error}', async () => {
  const out = await ex.execute('async () => { throw new Error("nope") }', []);
  assert.match(out.error, /nope/);
});

test('unknown sandbox function fails inside the sandbox', async () => {
  const out = await ex.execute('async () => await m.missing({})', { m: { present: () => 1 } });
  assert.match(out.error, /not a function/);
});

test('console output is captured in logs, not returned', async () => {
  const out = await ex.execute('async () => { console.log("hello"); return 1 }', []);
  assert.equal(out.result, 1);
  assert.deepEqual(out.logs, ['hello']);
});

test('timeout kills the sandbox', async () => {
  const quick = new NodeExecutor({ timeout: 400 });
  const out = await quick.execute('async () => { await sleep(5000); return 1 }', []);
  assert.match(out.error, /exceeded 400ms/);
});

test('empty code is rejected', async () => {
  const out = await ex.execute('', []);
  assert.match(out.error, /empty code/);
});

test('no filesystem access is granted implicitly', async () => {
  const out = await ex.execute('async () => { try { return require("fs").readdirSync(".") } catch (e) { return "blocked" } }', []);
  assert.equal(out.result, 'blocked');
});
