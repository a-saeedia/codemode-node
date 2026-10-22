// NodeExecutor — implementation of @cloudflare/codemode's Executor contract
// backed by a throwaway Node child process instead of a Cloudflare Worker.
//
//   interface Executor {
//     execute(code, providersOrFns, options?): Promise<{ result, error?, logs? }>
//   }
//
// The adapter never throws: host errors come back as `error`.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'runner.mjs');

export class NodeExecutor {
  /**
   * @param {object} [options]
   * @param {number} [options.timeout] hard wall-clock limit in ms (default 120000)
   * @param {string} [options.nodePath] node binary to spawn (default: current process)
   * @param {Record<string,string>} [options.env] extra env for the sandbox
   */
  constructor({ timeout = Number(process.env.CODEMODE_TIMEOUT_MS) || 120_000, nodePath = process.execPath, env = {} } = {}) {
    this.timeout = timeout;
    this.nodePath = nodePath;
    this.env = env;
  }

  execute(code, providersOrFns, options = {}) {
    const providers = Array.isArray(providersOrFns)
      ? providersOrFns
      : Object.entries(providersOrFns || {}).map(([name, fns]) => ({ name, fns }));

    const routing = new Map();
    const manifest = providers.map((p) => {
      const name = p.name || 'codemode';
      for (const [fn, impl] of Object.entries(p.fns || {})) routing.set(`${name}.${fn}`, impl);
      return { name, fns: Object.keys(p.fns || {}) };
    });

    return new Promise((resolve) => {
      const child = spawn(this.nodePath, [RUNNER], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: { ...process.env, ...this.env },
      });
      let done = false;
      const finish = (out) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        resolve(out);
      };
      const timer = setTimeout(
        () => finish({ result: undefined, error: `execution exceeded ${this.timeout}ms (killed)`, logs: [] }),
        this.timeout,
      );

      child.stderr.on('data', (d) => process.stderr.write(`[codemode:runner] ${d}`));
      child.on('error', (e) => finish({ result: undefined, error: String(e), logs: [] }));
      child.on('exit', (c) => { if (!done && c !== 0) finish({ result: undefined, error: `sandbox exited ${c}`, logs: [] }); });

      child.on('message', async (m) => {
        if (m.type === 'ready') {
          child.send({ type: 'run', code, providers: manifest });
          return;
        }
        if (m.type === 'result') {
          finish({ result: m.result, error: m.error, logs: m.logs || [] });
          return;
        }
        if (m.type === 'call') {
          const impl = routing.get(`${m.provider}.${m.fn}`);
          try {
            if (!impl) throw new Error(`unknown sandbox function ${m.provider}.${m.fn}`);
            const value = await impl(m.args, options);
            child.send({ type: 'call:reply', id: m.id, value });
          } catch (e) {
            child.send({ type: 'call:reply', id: m.id, error: e && e.message ? e.message : String(e) });
          }
        }
      });
    });
  }
}

export default NodeExecutor;
