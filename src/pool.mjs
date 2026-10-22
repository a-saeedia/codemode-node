// MCP client pool. Reads a config file in any of the common shapes:
//   opencode   { "mcp":        { name: { type:"local", command:[...], environment:{...} } } }
//   Claude/VS  { "mcpServers": { name: { command:"npx", args:[...], env:{...} } } }
//   VS Code    { "servers":    { ... } }
// Servers marked enabled:false are still pooled — disabled only means "not
// advertised to the model", not "unavailable".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crossSpawn from 'cross-spawn';

export function stripJsonc(src) {
  let out = '', i = 0, inStr = false, inLine = false, inBlock = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const home = os.homedir();
const CANDIDATES = [
  process.env.CODEMODE_CONFIG,
  path.join(process.cwd(), '.mcp.json'),
  path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  path.join(home, 'AppData', 'Roaming', 'opencode', 'opencode.jsonc'),
  path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
  path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
].filter(Boolean);

export function discoverConfig(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`config not found: ${explicit}`);
    return path.resolve(explicit);
  }
  return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function normalize(name, def) {
  if (!def || typeof def !== 'object') return null;
  const enabled = def.enabled !== false;
  const url = def.url || def.serverUrl;
  if (url) return { url, headers: def.headers || {}, enabled };
  let command = def.command;
  if (typeof command === 'string') command = [command, ...(def.args || [])];
  if (!Array.isArray(command) || !command.length) return null;
  return {
    command,
    environment: def.environment || def.env || {},
    cwd: def.cwd,
    enabled,
  };
}

export function loadServers(configPath) {
  if (!configPath) return {};
  let cfg;
  try {
    cfg = JSON.parse(stripJsonc(fs.readFileSync(configPath, 'utf8')));
  } catch (e) {
    process.stderr.write(`[codemode] failed to parse ${configPath}: ${e.message}\n`);
    return {};
  }
  const raw = cfg.mcpServers || cfg.mcp || cfg.servers || {};
  const out = {};
  for (const [name, def] of Object.entries(raw)) {
    if (/^codemode(-node)?$/.test(name)) continue; // never proxy ourselves
    const n = normalize(name, def);
    if (n) out[name] = n;
  }
  return out;
}

const tmpl = (v) =>
  typeof v === 'string' ? v.replace(/\{env:([A-Z0-9_]+)\}|\$\{env:([A-Z0-9_]+)\}/g, (_, a, b) => process.env[a || b] ?? '') : v;

class StdioClient {
  constructor(name, def) {
    this.name = name; this.def = def; this.id = 0; this.pending = new Map();
    this.tools = null; this.proc = null; this.ready = null;
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const [cmd, ...args] = this.def.command;
      const env = { ...process.env };
      for (const [k, v] of Object.entries(this.def.environment || {})) env[k] = String(tmpl(v));
      const proc = crossSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env, cwd: this.def.cwd || undefined });
      this.proc = proc;
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        const t = line.trim(); if (!t) return;
        let msg; try { msg = JSON.parse(t); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        }
      });
      proc.stderr.on('data', (d) => { if (process.env.CODEMODE_DEBUG) process.stderr.write(`[${this.name}] ${d}`); });
      proc.on('exit', (c) => {
        this.ready = null; this.proc = null; this.tools = null;
        for (const { reject: rej } of this.pending.values()) rej(new Error(`${this.name} exited ${c}`));
        this.pending.clear();
      });
      proc.on('error', (e) => reject(e));
      const t = setTimeout(() => reject(new Error(`${this.name} start timeout`)), 30_000);
      this.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codemode-node', version: '0.1.0' } })
        .then((r) => { clearTimeout(t); this.notify('notifications/initialized'); resolve(r); })
        .catch((e) => { clearTimeout(t); reject(e); });
    });
    return this.ready;
  }
  req(method, params, timeout = 60_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${this.name}.${method} timeout`)); }
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  notify(method, params) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch {}
  }
  async listTools() {
    if (this.tools) return this.tools;
    await this.start();
    this.tools = (await this.req('tools/list', {}, 30_000)).tools || [];
    return this.tools;
  }
  async call(tool, args) {
    await this.start();
    return this.req('tools/call', { name: tool, arguments: args || {} }, 300_000);
  }
  stop() { try { this.proc && this.proc.kill(); } catch {} }
}

class HttpClient {
  constructor(name, def) { this.name = name; this.def = def; this.id = 0; this.session = null; this.tools = null; this.ready = null; }
  headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.session) h['mcp-session-id'] = this.session;
    for (const [k, v] of Object.entries(this.def.headers || {})) h[k] = String(tmpl(v));
    return h;
  }
  async post(body) {
    const r = await fetch(this.def.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid;
    const ctype = r.headers.get('content-type') || '';
    const text = await r.text();
    if (ctype.includes('text/event-stream')) {
      const msgs = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
      return msgs.find((m) => m.id === body.id) || msgs[msgs.length - 1];
    }
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.post({ jsonrpc: '2.0', id: ++this.id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codemode-node', version: '0.1.0' } } });
    await this.ready;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return this.ready;
  }
  async listTools() {
    if (this.tools) return this.tools;
    await this.start();
    const r = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/list', params: {} });
    this.tools = (r && r.result && r.result.tools) || [];
    return this.tools;
  }
  async call(tool, args) {
    await this.start();
    const r = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name: tool, arguments: args || {} } });
    if (r && r.error) throw new Error(JSON.stringify(r.error));
    return r && r.result;
  }
  stop() {}
}

export function createPool(configPath) {
  const resolved = discoverConfig(configPath);
  const servers = loadServers(resolved);
  const clients = new Map();

  const client = (name) => {
    if (clients.has(name)) return clients.get(name);
    const def = servers[name];
    if (!def) throw new Error(`unknown MCP server '${name}'. Known: ${Object.keys(servers).join(', ') || '(none configured)'}`);
    const c = def.url ? new HttpClient(name, def) : new StdioClient(name, def);
    clients.set(name, c);
    return c;
  };

  return {
    configPath: resolved,
    names: () => Object.keys(servers),
    servers,
    client,
    tools: (name) => client(name).listTools(),
    call: (name, tool, args) => client(name).call(tool, args),
    stopAll: () => { for (const c of clients.values()) c.stop(); },
  };
}
