// Host-side operations exposed to the sandbox. Nothing here runs inside the
// sandbox: the sandbox only gets proxies that IPC back to these functions.
//
// Cross-platform: PowerShell on Windows, /bin/sh elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { z } from 'zod';

export const ROOT = process.env.CODEMODE_ROOT || os.homedir();
const MAX_OUT = 200_000;
const isWin = process.platform === 'win32';

/* ------------------------------------------------------------------ process */

const POWERSHELL = isWin
  ? [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ].find((p) => fs.existsSync(p)) || 'powershell.exe'
  : null;

const POSIX_SHELL = process.env.SHELL || '/bin/sh';

// A bare child process can inherit a stripped PATH (common under agent hosts).
// Rebuild it from the well-known locations so git/curl/findstr resolve.
const SYS_PATHS = isWin
  ? [
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\nodejs',
      path.dirname(process.execPath),
    ]
  : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export const BASE_ENV = {
  ...process.env,
  PATH: [...SYS_PATHS, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
  NO_COLOR: '1',
};

export function run(bin, args, { cwd, timeout = 120_000, input, env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = execFile(
      bin,
      args,
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...BASE_ENV, ...env }, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || '').slice(0, MAX_OUT),
          stderr: String(stderr || '').slice(0, MAX_OUT),
          ms: Date.now() - t0,
        });
      },
    );
    if (input != null && child.stdin) child.stdin.end(input);
  });
}

/** Run a shell command. PowerShell on Windows, /bin/sh elsewhere. */
export const shell = (cmd, { cwd, timeout_ms } = {}) =>
  isWin
    ? run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '-'], { cwd, input: cmd, timeout: timeout_ms })
    : run(POSIX_SHELL, ['-s'], { cwd, input: cmd, timeout: timeout_ms });

/* --------------------------------------------------------------------- files */

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.cache', '.venv', 'venv']);

function walk(dir, out = [], depth = 0, maxDepth = 8) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || depth >= maxDepth) continue;
      walk(p, out, depth + 1, maxDepth);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function globToRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

export const fsx = {
  read: (file) => fs.readFileSync(path.resolve(ROOT, file), 'utf8').slice(0, MAX_OUT),
  write: (file, content) => { const p = path.resolve(ROOT, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return { written: true, bytes: Buffer.byteLength(content) }; },
  append: (file, content) => { const p = path.resolve(ROOT, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, content); return { appended: true }; },
  exists: (p) => fs.existsSync(path.resolve(ROOT, p)),
  stat: (p) => { const s = fs.statSync(path.resolve(ROOT, p)); return { size: s.size, isDir: s.isDirectory(), mtime: s.mtime.toISOString() }; },
  list: (dir = '.') => fs.readdirSync(path.resolve(ROOT, dir), { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })),
  mkdir: (dir) => { fs.mkdirSync(path.resolve(ROOT, dir), { recursive: true }); return { ok: true }; },
  remove: (p) => { fs.rmSync(path.resolve(ROOT, p), { recursive: true, force: true }); return { removed: true }; },
  glob: (pattern, cwd = '.') => {
    const base = path.resolve(ROOT, cwd);
    const re = globToRegExp(pattern);
    return walk(base).map((f) => path.relative(base, f).split(path.sep).join('/')).filter((f) => re.test(f)).sort();
  },
  grep: (pattern, cwd = '.', { include, ignore_case = false, limit = 200 } = {}) => {
    const base = path.resolve(ROOT, cwd);
    const re = new RegExp(pattern, ignore_case ? 'i' : '');
    const inc = include ? globToRegExp(include.replace(/^\*\*\//, '**/')) : null;
    const hits = [];
    for (const f of walk(base)) {
      const rel = path.relative(base, f).split(path.sep).join('/');
      if (inc && !inc.test(rel) && !inc.test(path.basename(rel))) continue;
      let text;
      try { if (fs.statSync(f).size > 2_000_000) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!re.test(text)) continue;
      text.split(/\r?\n/).forEach((line, i) => { if (hits.length < limit && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`); });
      if (hits.length >= limit) break;
    }
    return hits;
  },
};

/* ---------------------------------------------------------------------- http */

export async function http(url, init = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout_ms || 30_000) });
  return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), text: (await r.text()).slice(0, MAX_OUT), ms: Date.now() - t0 };
}

export const httpJson = async (url, init = {}) => {
  const r = await http(url, init);
  let json;
  try { json = JSON.parse(r.text); } catch { json = null; }
  return { status: r.status, ok: r.ok, json, ms: r.ms };
};

/* ---------------------------------------------------------------- cloudflare */

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;

export function cloudflareConfigured() {
  return Boolean(CF_TOKEN);
}

export async function cf({ method = 'GET', path: apiPath, query, body } = {}) {
  if (!CF_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is not set; export it to use cf_* helpers');
  const p = String(apiPath).replace('{account}', CF_ACCOUNT || '');
  const url = new URL(`https://api.cloudflare.com/client/v4${p.startsWith('/') ? p : '/' + p}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || json?.success === false) {
    throw new Error(`Cloudflare API ${r.status}: ${JSON.stringify(json?.errors || json).slice(0, 400)}`);
  }
  return json;
}

/* ---------------------------------------------------------------------- moli */

const MOLI_BIN = process.env.MOLI_BIN;

export function moliConfigured() {
  return Boolean(MOLI_BIN && fs.existsSync(MOLI_BIN));
}

export async function moliFetch(url, { format = 'markdown', wait = 'done', timeout_ms = 30_000 } = {}) {
  if (!moliConfigured()) throw new Error('MOLI_BIN is not set (or the binary is missing)');
  const r = await run(MOLI_BIN, ['fetch', '--dump', format, '--wait', wait, url], { timeout: timeout_ms });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 500) || `moli exited ${r.code}`);
  return r.stdout;
}

/* --------------------------------------------------------------------- tools */

const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e && e.message ? e.message : String(e) }] });

function reg(server, name, description, shape, fn) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try { return ok(await fn(args || {})); } catch (e) { return fail(e); }
  });
}

export function registerHostTools(server, pool, { cloudflare = true, moli = true } = {}) {
  reg(server, 'shell', 'Run a PowerShell (Windows) or POSIX shell command. Returns {code,stdout,stderr,ms}.', {
    cmd: z.string(),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  }, (a) => shell(a.cmd, a));

  reg(server, 'fs_read', 'Read a UTF-8 text file. Relative paths resolve under the sandbox ROOT.', { path: z.string() }, (a) => fsx.read(a.path));
  reg(server, 'fs_write', 'Write a file (creates parent dirs).', { path: z.string(), content: z.string() }, (a) => fsx.write(a.path, a.content));
  reg(server, 'fs_append', 'Append to a file.', { path: z.string(), content: z.string() }, (a) => fsx.append(a.path, a.content));
  reg(server, 'fs_exists', 'True if the path exists.', { path: z.string() }, (a) => fsx.exists(a.path));
  reg(server, 'fs_stat', 'Size / dir / mtime.', { path: z.string() }, (a) => fsx.stat(a.path));
  reg(server, 'fs_list', 'List a directory.', { dir: z.string().optional() }, (a) => fsx.list(a.dir));
  reg(server, 'fs_glob', 'Glob files under cwd (forward slashes, *, ?). Skips node_modules/.git/dist.', { pattern: z.string(), cwd: z.string().optional(), limit: z.number().int().positive().optional() }, (a) => fsx.glob(a.pattern, a.cwd).slice(0, a.limit || 2000));
  reg(server, 'fs_grep', 'Regex search under cwd. Returns ["file:line: text"].', { pattern: z.string(), cwd: z.string().optional(), include: z.string().optional(), limit: z.number().int().positive().optional(), ignore_case: z.boolean().optional() }, (a) => fsx.grep(a.pattern, a.cwd, a));
  reg(server, 'fs_remove', 'Delete a file or directory tree.', { path: z.string() }, (a) => fsx.remove(a.path));
  reg(server, 'fs_mkdir', 'Create a directory tree.', { path: z.string() }, (a) => fsx.mkdir(a.path));

  reg(server, 'http', 'HTTP request. Returns {status, ok, headers, text, ms}.', {
    url: z.string(), method: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), timeout_ms: z.number().int().positive().optional(),
  }, (a) => http(a.url, a));
  reg(server, 'http_json', 'HTTP request parsed as JSON. Returns {status, ok, json}.', {
    url: z.string(), method: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), timeout_ms: z.number().int().positive().optional(),
  }, (a) => httpJson(a.url, a));

  if (cloudflare && cloudflareConfigured()) {
    const shape = { method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.unknown().optional() };
    reg(server, 'cf_get', 'Cloudflare API GET (v4). Use {account} as the account-id placeholder.', { path: z.string(), query: z.record(z.string(), z.string()).optional() }, (a) => cf({ ...a, method: 'GET' }));
    reg(server, 'cf_post', 'Cloudflare API POST (v4).', { path: z.string(), body: z.unknown().optional() }, (a) => cf({ ...a, method: 'POST' }));
    reg(server, 'cf_patch', 'Cloudflare API PATCH (v4).', { path: z.string(), body: z.unknown().optional() }, (a) => cf({ ...a, method: 'PATCH' }));
    reg(server, 'cf_put', 'Cloudflare API PUT (v4).', { path: z.string(), body: z.unknown().optional() }, (a) => cf({ ...a, method: 'PUT' }));
    reg(server, 'cf_del', 'Cloudflare API DELETE (v4).', { path: z.string() }, (a) => cf({ ...a, method: 'DELETE' }));
    reg(server, 'cf_request', 'Cloudflare API request with an explicit method.', shape, (a) => cf(a));
  }

  if (moli && moliConfigured()) {
    reg(server, 'moli_fetch', 'Fetch a URL through Moli (real browser engine). Returns {code,out,err,ms}.', {
      url: z.string(), format: z.string().optional(), wait: z.string().optional(), timeout_ms: z.number().int().positive().optional(),
    }, async (a) => ({ out: await moliFetch(a.url, a), code: 0 }));
  }

  if (pool && pool.names().length) {
    reg(server, 'mcp_list', 'List the configured MCP servers (or the tools of one).', { server: z.string().optional() }, async (a) => a.server ? pool.tools(a.server) : pool.names());
    reg(server, 'mcp_tools', 'Raw tool schemas for one MCP server.', { server: z.string() }, (a) => pool.tools(a.server));
    reg(server, 'mcp_call', 'Call any configured MCP server tool. Disabled servers are still reachable here.', {
      server: z.string(), tool: z.string(), args: z.unknown().optional(),
    }, (a) => pool.call(a.server, a.tool, a.args || {}));
  }
}
