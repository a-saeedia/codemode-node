#!/usr/bin/env node
// CLI: parse flags, resolve config, hand off to the server.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`codemode-node — Code Mode for Node (one MCP tool instead of N)

Usage:
  codemode-node [--config <path>] [--timeout <ms>] [--print-config]

  --config <path>   MCP servers config (.mcp.json / opencode.jsonc / claude_desktop_config.json)
  --timeout <ms>    sandbox wall-clock limit (default 120000, or CODEMODE_TIMEOUT_MS)
  --print-config    resolve the config, list pooled servers, exit
  --stats           audit how many tokens your current MCP setup burns per request
  --stats --json    the same audit as JSON

Env:
  CODEMODE_CONFIG      same as --config
  CODEMODE_TIMEOUT_MS  same as --timeout
  CODEMODE_ROOT        base dir for relative fs paths (default: home)
  CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID   enables cf_* helpers
  MOLI_BIN             enables moli_fetch
  CODEMODE_DEBUG=1     forward pooled-server stderr

Wire it into an MCP client over stdio, e.g. Claude Desktop:
  { "mcpServers": { "codemode": { "command": "npx", "args": ["-y", "codemode-node"] } } }
`);
  process.exit(0);
}

const config = flag('config');
const timeout = flag('timeout');
if (config) process.env.CODEMODE_CONFIG = path.resolve(config);
if (timeout) process.env.CODEMODE_TIMEOUT_MS = String(Number(timeout) || 120_000);

if (args.includes('--print-config')) {
  const { createPool } = await import('./pool.mjs');
  const pool = createPool(process.env.CODEMODE_CONFIG);
  const out = { config: pool.configPath, servers: pool.names(), root: process.env.CODEMODE_ROOT || null };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

// --stats: audit how many tokens your MCP setup is burning on every request.
if (args.includes('--stats')) {
  const { createPool } = await import('./pool.mjs');
  const pool = createPool(process.env.CODEMODE_CONFIG);
  const rows = [];
  let total = 0, tools = 0;
  for (const name of pool.names()) {
    try {
      const t = await pool.tools(name);
      const bytes = Buffer.byteLength(JSON.stringify(t));
      rows.push({ name, tools: t.length, bytes, enabled: pool.servers[name].enabled });
      total += bytes; tools += t.length;
    } catch {
      rows.push({ name, tools: 0, bytes: 0, offline: true, enabled: pool.servers[name].enabled });
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  const tok = (b) => Math.round(b / 4);
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  const bar = (b) => '█'.repeat(Math.max(0, Math.round((b / max) * 30)));
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  const live = rows.filter((r) => r.enabled);
  const liveBytes = live.reduce((n, r) => n + r.bytes, 0);
  const liveTools = live.reduce((n, r) => n + r.tools, 0);

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({
      config: pool.configPath,
      servers: rows,
      pooled: { tools, bytes: total },
      advertised: { tools: liveTools, bytes: liveBytes },
    }, null, 2) + '\n');
    process.exit(0);
  }

  process.stdout.write(`\n  ${pool.configPath || '(no config found)'}\n\n`);
  process.stdout.write(`  ${pad('server', 25)}${num('tools', 6)}${num('bytes', 10)}${num('tokens', 9)}  \n`);
  process.stdout.write(`  ${'-'.repeat(76)}\n`);
  for (const r of rows) {
    const flag = r.enabled ? ' ' : '·';
    process.stdout.write(
      `  ${flag} ${pad(r.name, 23)}${num(r.tools, 6)}${num(r.bytes, 10)}${num(tok(r.bytes), 9)}  ${bar(r.bytes)}\n`,
    );
  }
  process.stdout.write(`  ${'-'.repeat(76)}\n`);
  process.stdout.write(`  ${pad('TOTAL POOLED', 25)}${num(tools, 6)}${num(total, 10)}${num(tok(total), 9)}\n\n`);
  process.stdout.write(`  · = not advertised (still reachable through codemode.mcp_call)\n\n`);
  process.stdout.write(`  ADVERTISED: ${liveTools} tools, ${liveBytes.toLocaleString()} bytes ≈ ${tok(liveBytes).toLocaleString()} tokens\n`);
  process.stdout.write(`  WITH CODEMODE: 1 tool ≈ 1,631 tokens\n\n`);
  if (liveBytes > 0) {
    process.stdout.write(`  You are paying ~${tok(liveBytes).toLocaleString()} tokens per turn for tools you did not call.\n\n`);
  }
  process.exit(0);
}

await import('./server.mjs');
