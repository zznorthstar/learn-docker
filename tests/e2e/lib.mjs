// Shared helpers for end-to-end runs: start the real Worker (static dist + /mcp + /ws) and drive Chrome.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startServer(port = Number(process.env.E2E_PORT ?? 38792)) {
  const proc = spawn(path.join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), '--ip', '127.0.0.1', '--local', '--inspector-port', String(port + 100), '--persist-to', '.wrangler/e2e-state'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so stop() can take workerd down with it
    env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 480; i++) {
    if (/Ready on/.test(log)) break;
    if (proc.exitCode !== null) throw new Error('wrangler exited:\n' + log);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!/Ready on/.test(log)) throw new Error('wrangler did not start:\n' + log);
  const stop = () => {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  };
  process.once('exit', stop);
  return { url: `http://127.0.0.1:${port}`, stop };
}

export async function launch(opts = {}) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  return { browser, context };
}
