#!/usr/bin/env node
// codemode-node — Code Mode for Node.
//
//   agent -> this server (stdio) -> one `code` tool
//                                -> host tools (shell/fs/http/mcp/cf/moli)
//                                -> NodeExecutor -> sandboxed node child
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { codeMcpServer } from '@cloudflare/codemode/mcp';
import { NodeExecutor } from './executor.mjs';
import { registerHostTools } from './host.mjs';
import { createPool } from './pool.mjs';

const VERSION = '0.1.0';

const DESCRIPTION = `Execute one JavaScript program that achieves the whole goal. This replaces chains of separate tool calls: one call here does the work of N, and intermediate data never enters your context.

Available:
{{types}}

Rules:
- Write an async arrow function that returns the final value. Do NOT use TypeScript syntax.
- Use forward slashes in paths. A backslash inside a JS string is an escape ("\\p" becomes "p") and silently corrupts the path.
- Return a small JSON-able summary. Anything you do not return is discarded, which is the point: filter and aggregate inside the code, not in the conversation.
- console.log output is captured host-side but is NOT returned — collect progress in an array and return it.
- Loop freely: many files, many URLs, many tool calls per execution.
- Default timeout 120s (CODEMODE_TIMEOUT_MS). Errors throw; catch them inside the code if you want to continue.

{{example}}`;

const pool = createPool(process.env.CODEMODE_CONFIG);
const upstream = new McpServer({ name: 'codemode-host', version: VERSION });
registerHostTools(upstream, pool);

const server = await codeMcpServer({
  server: upstream,
  executor: new NodeExecutor(),
  description: DESCRIPTION,
});

await server.connect(new StdioServerTransport());

const shutdown = () => { try { pool.stopAll(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

const n = pool.names().length;
process.stderr.write(
  `[codemode-node] v${VERSION} up — 1 tool, ${n} MCP server(s) pooled${n ? ` from ${pool.configPath}` : ' (no config found)'}\n`,
);
