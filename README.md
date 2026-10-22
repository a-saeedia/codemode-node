# codemode-node

**Code Mode for Node.** One MCP tool instead of a hundred.

Cloudflare's [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) turns an MCP server into a single `code` tool: the model writes one JavaScript program that calls all your tools, instead of one tool call per step. It ships an executor for Cloudflare Workers — which means you need a Workers account to use a pattern that runs fine on a laptop.

This is the missing **Node executor**, plus a ready-to-run MCP server around it.

```bash
npx -y codemode-node
```

---

## The problem

Every MCP server you connect injects its tool schemas into every request. Measured on a normal dev setup with 8 servers:

| | tools | schema bytes | ~tokens / request |
|---|---|---|---|
| 8 MCP servers | 113 | 174,406 | **43,602** |
| this server | 1 | 6,524 | **1,631** |

That is **26× less context before you type a word** — and it grows with every server you add. `github` alone was 120 KB of it.

Code Mode replaces that with one tool. The model writes:

```js
const repos = await codemode.fs_glob({ pattern: '*/package.json' });
const stale = [];
for (const f of repos) {
  const pkg = JSON.parse(await codemode.fs_read({ path: f }));
  if (!pkg.description) stale.push(f);
}
return { total: repos.length, stale };
```

…instead of a dozen round trips, each re-sending every schema and dumping raw output into the conversation.

## Measured

Same task, both ways, 3 runs, median:

| | round trips | payload to model | ~tokens | local wall |
|---|---|---|---|---|
| 5 discrete tool calls | 5 | 41,812 B | 10,453 | 2,240 ms |
| one `code` call | **1** | **145 B** | **36** | 2,733 ms |

The `code` path is ~0.5 s slower locally (IPC + child spawn) and 288× smaller in what reaches the model. Since each avoided round trip costs a full model call, end-to-end it wins by seconds per task.

## How it works

```
agent ──stdio──▶ codemode-node
                    └─ codeMcpServer()            ← Cloudflare's package
                         ├─ upstream McpServer    ← host tools (zod schemas)
                         └─ NodeExecutor          ← this repo (implements Executor)
                              └─ node child       ← sandbox, fresh per call
```

`Executor` is a documented extension point in `@cloudflare/codemode`:

```ts
interface Executor {
  execute(code, providersOrFns, options?): Promise<{ result, error?, logs? }>;
}
```

So Cloudflare generates the TypeScript declarations from your tool schemas, owns the `code` tool description, result unwrapping and truncation. This repo only supplies the sandbox.

## Quick start

```bash
npx -y codemode-node --print-config   # what did it find?
npx -y codemode-node                  # stdio MCP server
```

Wire it in:

**Claude Desktop / Claude Code** (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "codemode": { "command": "npx", "args": ["-y", "codemode-node"] }
  }
}
```

**OpenCode**

```jsonc
{
  "mcp": {
    "codemode": { "type": "local", "command": ["npx", "-y", "codemode-node"], "enabled": true }
  }
}
```

**Cursor / VS Code** — same shape under `servers`.

Then disable the MCP servers you no longer want to advertise. They stay reachable through `codemode.mcp_call({ server, tool, args })`.

## Config

It auto-discovers the first of:

1. `--config <path>` / `CODEMODE_CONFIG`
2. `./.mcp.json`
3. `~/.config/opencode/opencode.jsonc` (and the Windows location)
4. Claude Desktop config (all three platforms)

It understands `mcpServers` (Claude), `mcp` (OpenCode) and `servers` (VS Code), including JSONC comments. Servers with `enabled: false` are **still pooled** — disabled means "not advertised", not "unavailable".

## Sandbox API

Everything takes a single object argument and returns JSON.

| namespace | functions |
|---|---|
| `codemode` | `shell`, `fs_read`, `fs_write`, `fs_append`, `fs_exists`, `fs_stat`, `fs_list`, `fs_glob`, `fs_grep`, `fs_remove`, `fs_mkdir`, `http`, `http_json` |
| `codemode` | `mcp_list`, `mcp_tools`, `mcp_call` — any pooled server |
| `codemode` | `cf_get`, `cf_post`, `cf_patch`, `cf_put`, `cf_del`, `cf_request` — only when `CLOUDFLARE_API_TOKEN` is set |
| `codemode` | `moli_fetch` — only when `MOLI_BIN` is set |
| globals | `sleep(ms)`, `env`, `ROOT`, `log()` |

Return a small summary. `console.log` is captured but **not** returned — anything you don't return is discarded, which is the point.

## Security model

Read this before pointing it at anything untrusted.

- Each call runs in a **fresh Node child process** that exits afterwards. No state persists between calls.
- The sandbox is `node:vm` with no `require`, no `import`, no `process`, no filesystem. Its only capabilities are the proxies you can see.
- **`node:vm` is not a security boundary.** A determined escape is possible, and host functions will happily run whatever you ask: `shell` is a shell, `fs_write` writes, `http` reaches the network. The isolation is *capability* isolation, not a jail.
- Treat it as: **the model can do anything you could do in a terminal.** That is the deal with every coding agent. If you need a real boundary, run this inside a container/VM.

No secrets are read from disk. Credentials come from the environment only.

## Limitations

- **No streaming.** The result arrives once, at the end. Long jobs look like a hang; keep them under the timeout and return progress.
- **One interpreter, no TypeScript.** Plain JS only.
- **`console.log` is dropped** by the wrapping package — return your progress instead.
- **Cold start** is ~1.5 s (MCP SDK + zod + type generation), then ~250–500 ms per call.
- **Only stdio** on the server side. Upstream servers can be stdio or HTTP.

## Related

- [`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/main/packages/codemode) — the pattern and the Workers executor. This package depends on it and adds nothing to the protocol.
- [`universal-tool-calling-protocol/code-mode`](https://github.com/universal-tool-calling-protocol/code-mode) — protocol-agnostic Code Mode (MCP + OpenAPI + native tools).

If you're on Cloudflare Workers, use their `DynamicWorkerExecutor` — it's a real isolate and strictly better than this.

## License

MIT © Arman Saeedi
