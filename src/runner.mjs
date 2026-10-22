// Generic sandbox runner. Receives a provider manifest, exposes each provider's
// functions as namespace.fn(args) backed by IPC to the host, then evaluates the code.
import os from 'node:os';
import vm from 'node:vm';

const logs = [];
const fmt = (v) => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

let seq = 0;
const pending = new Map();
process.on('message', (m) => {
  if (!m) return;
  if (m.type === 'call:reply' && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error)) : resolve(m.value);
  }
  if (m.type === 'run') {
    execute(m.code, m.providers || []).then(
      (result) => process.send({ type: 'result', result, logs }),
      (e) => process.send({ type: 'result', result: undefined, error: (e && e.message) || String(e), logs }),
    ).finally(() => setTimeout(() => process.exit(0), 10));
  }
});

const call = (provider, fn) => (...args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: 'call', id, provider, fn, args: args.length <= 1 ? args[0] : args });
  });

function buildContext(providers) {
  const capture = (...a) => logs.push(a.map(fmt).join(' '));
  const sandbox = {
    console: { log: capture, error: capture, warn: capture, info: capture, debug: capture },
    JSON, Math, Date, URL, URLSearchParams, Buffer, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, RegExp, Map, Set, Array, Object, String, Number, Boolean, Error, Symbol,
    structuredClone, Intl, BigInt, Proxy, Reflect,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    crypto: globalThis.crypto,
    ROOT: os.homedir(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: capture,
    env: { ...process.env },
  };
  for (const p of providers) {
    const ns = {};
    for (const fn of p.fns || []) ns[fn] = call(p.name, fn);
    sandbox[p.name] = ns;
  }
  return vm.createContext(sandbox, { name: 'codemode' });
}

const FN_LIKE = /^\s*(async\s*)?(\(|function\b|async\b|[A-Za-z_$][\w$]*\s*=>)/;

async function execute(code, providers) {
  const src = String(code || '').trim();
  if (!src) throw new Error('empty code');
  const ctx = buildContext(providers);
  if (FN_LIKE.test(src)) {
    const fn = vm.runInContext(`(${src})`, ctx, { timeout: 10_000 });
    if (typeof fn !== 'function') throw new Error('code looked like a function but did not evaluate to one');
    return await fn();
  }
  return await vm.runInContext(`(async () => { ${src} })()`, ctx, { timeout: 10_000 });
}

process.send({ type: 'ready' });
