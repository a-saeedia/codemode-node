# codemode-node

[![CI](https://github.com/a-saeedia/codemode-node/actions/workflows/ci.yml/badge.svg)](https://github.com/a-saeedia/codemode-node/actions/workflows/ci.yml)

One MCP tool in front of all your MCP servers. Cloudflare's [Code Mode](https://github.com/cloudflare/agents/tree/main/packages/codemode) pattern, running on Node instead of Workers.

```sh
npx -y https://github.com/a-saeedia/codemode-node/tarball/main --stats
```

Status: works, unpolished, running on my own machine. npm publish pending, hence the tarball URL.

## The problem

Every MCP server you connect gets its schemas pasted into the context on every request. From my own config, with four servers turned off:

```
8 MCP servers      113 tools   174,406 bytes   ~43,602 tokens
codemode-node        1 tool      6,524 bytes    ~1,631 tokens
```

43k tokens before the model has done anything, and it grows with each server you install (`github` alone was 120 KB). The `--stats` command below measures your own config instead of trusting mine.

With the `code` tool the model writes one program per task:

```js
const files = await codemode.fs_glob({ pattern: '*/package.json' });
const stale = [];
for (const f of files) {
  const pkg = JSON.parse(await codemode.fs_read({ path: f }));
  if (!pkg.description) stale.push(f);
}
return { total: files.length, stale };
```

One round trip, one small object back. Everything else stays on disk and in the process.

## Install

```sh
npx -y https://github.com/a-saeedia/codemode-node/tarball/main
```

Claude Desktop / Claude Code:

```json
{
  "mcpServers": {
    "codemode": {
      "command": "npx",
      "args": ["-y", "https://github.com/a-saeedia/codemode-node/tarball/main"]
    }
  }
}
```

OpenCode:

```jsonc
{
  "mcp": {
    "codemode": {
      "type": "local",
      "command": ["npx", "-y", "https://github.com/a-saeedia/codemode-node/tarball/main"],
      "enabled": true
    }
  }
}
```

Cursor and VS Code take the same shape (`servers` in `.vscode/mcp.json`, `mcpServers` in `.mcp.json`).

Then stop advertising the servers you don't want in context. They remain reachable through `codemode.mcp_call({ server, tool, args })`. Disabled means hidden, not gone.

## The audit

`--stats` reads your real config, boots each server, and counts what you're actually sending:

```
  server                    tools     bytes   tokens
  ----------------------------------------------------------------------------
  · higgsfield                 48    182757    45689  ██████████████████████████████
    github                     44    120572    30143  ████████████████████
    director                   26     19725     4931  ███
  · playwright                 24     18502     4626  ███
  ----------------------------------------------------------------------------
  TOTAL POOLED                282    441280   110320

  · = not advertised (still reachable through codemode.mcp_call)

  ADVERTISED: 113 tools, 174,406 bytes ≈ 43,602 tokens
  WITH CODEMODE: 1 tool ≈ 1,631 tokens

  You are paying ~43,602 tokens per turn for tools you did not call.
```

`--stats --json` for anything that isn't a human.

## Sandbox API

Every function takes one object. All of it hangs off a single `codemode` namespace inside the sandbox.

| group | functions |
|---|---|
| shell / files | `shell`, `fs_read`, `fs_write`, `fs_append`, `fs_exists`, `fs_stat`, `fs_list`, `fs_glob`, `fs_grep`, `fs_remove`, `fs_mkdir` |
| network | `http`, `http_json` |
| MCP | `mcp_list`, `mcp_tools`, `mcp_call` |
| Cloudflare | `cf_get`, `cf_post`, `cf_patch`, `cf_put`, `cf_del`, `cf_request` (only with `CLOUDFLARE_API_TOKEN`) |
| Moli | `moli_fetch` (only with `MOLI_BIN`) |
| globals | `sleep(ms)`, `env`, `ROOT`, `log()` |

Whatever the program returns is the only thing sent back. `console.log` is captured in `logs`, never returned to the model, so progress has to be part of the return value.

## Config

Looks for the first of these:

1. `--config <path>` or `CODEMODE_CONFIG`
2. `./.mcp.json`
3. `~/.config/opencode/opencode.jsonc`
4. Claude Desktop config, any platform

It reads `mcpServers` (Claude), `mcp` (OpenCode) and `servers` (VS Code), including JSONC comments and `{env:VAR}` interpolation.

```sh
npx -y https://github.com/a-saeedia/codemode-node/tarball/main --print-config
```

| env | effect |
|---|---|
| `CODEMODE_ROOT` | base directory for relative fs paths (default: home) |
| `CODEMODE_TIMEOUT_MS` | wall clock limit per call (default 120000) |
| `CODEMODE_DEBUG=1` | forward pooled-server stderr |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | enables `cf_*` |
| `MOLI_BIN` | enables `moli_fetch` |

## Security

Each call gets a fresh Node child process that exits afterwards. The sandbox is `node:vm` with no `require`, `import`, `process` or filesystem; the proxies above are its entire capability set.

`node:vm` is not a security boundary. Escapes exist, and the proxies are real: `shell` runs commands, `fs_write` writes files, `http` opens sockets. The model can do anything you can do in a terminal, which is the same deal every coding agent offers. If that's not acceptable, run the whole thing in a container.

No credentials are read from disk. They come from the environment.

## Numbers

Same task both ways, three runs, median, Windows 11 / Node 22:

| | round trips | bytes to the model | tokens | wall time |
|---|---:|---:|---:|---:|
| 5 tool calls | 5 | 41,812 | 10,453 | 2,240 ms |
| 1 `code` call | 1 | 145 | 36 | 2,733 ms |

About half a second slower locally, 288× less context. Each skipped round trip is a full model call, so on a real task the difference is seconds, not milliseconds.

## Limitations

- No streaming. One result at the end; long jobs look like a hang.
- Plain JavaScript. No TypeScript, no imports.
- Cold start around 1.5 s, then 250 to 500 ms per call from process spawn and IPC.
- stdio on the server side only. Upstream servers can be stdio or HTTP.
- Pinned to `@cloudflare/codemode@0.5.5`. Upstream is Workers-first and a minor bump can add a `cloudflare:workers` import that Node cannot load ([#2142](https://github.com/cloudflare/agents/issues/2142)). Upgrade deliberately and run the tests.

## Prior art

`@cloudflare/codemode` supplies the type generation, tool description, result unwrapping and truncation. This repo supplies the executor and the server. The protocol idea comes from [UTCP's code-mode](https://github.com/universal-tool-calling-protocol/code-mode), which is more ambitious and framework-agnostic.

MIT.
