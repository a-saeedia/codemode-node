// End-to-end: boot the MCP server over stdio, call the single `code` tool,
// verify the sandbox can reach host tools. No external MCP servers required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-e2e-'));
const config = path.join(root, 'empty.json');
fs.writeFileSync(config, '{}');
const child = spawn(process.execPath, [path.resolve('src/cli.mjs'), '--config', config], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, CODEMODE_ROOT: root },
});

let id = 0;
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
const req = (method, params) => new Promise((resolve) => {
  const i = ++id; waiting.set(i, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
});

await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = (await req('tools/list', {})).result.tools;
assert.equal(tools.length, 1, 'exactly one tool is advertised');
assert.equal(tools[0].name, 'code');

const code = `
  await codemode.fs_mkdir({ path: 'sub' });
  await codemode.fs_write({ path: 'sub/a.txt', content: 'hello' });
  const back = await codemode.fs_read({ path: 'sub/a.txt' });
  const hits = await codemode.fs_grep({ pattern: 'hello', cwd: '.' });
  const sh = await codemode.shell({ cmd: 'echo hi' });
  return { back, hits: hits.length, sh: sh.stdout.trim(), files: (await codemode.fs_glob({ pattern: '**/*.txt' })).length };
`;

const res = await req('tools/call', { name: 'code', arguments: { code } });
const payload = JSON.parse(res.result.content[0].text);
assert.equal(payload.back, 'hello');
assert.ok(payload.hits >= 1, 'grep found the file');
assert.ok(payload.sh.length > 0, 'shell produced output');
assert.equal(payload.files, 1);

child.kill();
fs.rmSync(root, { recursive: true, force: true });
console.log('e2e ok:', payload);
