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

await import('./server.mjs');
