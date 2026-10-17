import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayClient, type RelayState } from '../../src/relay/client';
import { WorldEngine } from '../../src/engine/engine';
import { handleTool } from '../../src/engine/tools';
import { newLabId, newSecret, bearer } from '../../src/app/identity';
import { TOOLS } from '../../shared/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.RELAY_PORT ?? 38791);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
let wrangler: ChildProcess;

async function rpc(key: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${HTTP}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}

const call = (key: string, name: string, args: object = {}, id = 1) => rpc(key, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const parse = (r: { json: any }) => JSON.parse(r.json.result.content[0].text);

/** a fake browser tab: the real engine + the real relay client */
function browser(labId: string, secret: string) {
  const engine = new WorldEngine();
  engine.reset('welcome', 'system');
  const states: RelayState[] = [];
  const mcp: string[] = [];
  const client = new RelayClient({
    base: WS,
    lab: labId,
    secret,
    onCall: (tool, args) => {
      engine.link.agent = true;
      const r = handleTool(engine, tool, args);
      return { text: JSON.stringify(r.data), isError: r.isError };
    },
    onState: (s) => states.push(s),
    onMcp: (c) => mcp.push(c),
  });
  const waitFor = async (s: RelayState) => {
    for (let i = 0; i < 100 && client.state !== s; i++) await new Promise((r) => setTimeout(r, 50));
    expect(client.state).toBe(s);
  };
  return { engine, client, states, mcp, waitFor };
}

beforeAll(async () => {
  wrangler = spawn('node_modules/.bin/wrangler', ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--local', '--inspector-port', String(PORT + 100), '--persist-to', '.wrangler/test-state'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' } });
  let log = '';
  wrangler.stdout!.on('data', (d) => (log += d));
  wrangler.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 400; i++) {
    if (/Ready on/.test(log)) return;
    if (wrangler.exitCode !== null) throw new Error('wrangler exited: ' + log);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('wrangler did not start: ' + log);
});

afterAll(() => {
  try {
    process.kill(-wrangler.pid!, 'SIGTERM');
  } catch {
    wrangler?.kill('SIGTERM');
  }
});

describe('relay + MCP end to end', () => {
  it('refuses browser sockets from foreign origins and malformed lab ids', async () => {
    // fetch() forbids Upgrade/Connection headers, so use a raw HTTP request
    const status = (path: string, headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 101);
        });
        req.on('error', reject);
        req.end();
      });
    const up = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    expect(await status('/ws?lab=w_abcdefghij', { ...up, Origin: 'https://evil.example' })).toBe(403);
    expect(await status('/ws?lab=..%2F..%2Fetc', up)).toBe(400);
    expect(await status('/ws?lab=w_abcdefghij', {})).toBe(426);
    expect(await status('/ws?lab=w_abcdefghij', { ...up, Origin: `http://127.0.0.1:${PORT}` })).toBe(101); // same origin is fine
  });

  const labId = newLabId();
  const secret = newSecret();
  const key = bearer({ labId, secret, createdAt: 0 });

  it('rejects calls without a key, with a malformed key, and for a lab nobody opened', async () => {
    expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await rpc('nonsense', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const r = await rpc(key, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('unknown_lab');
  });

  it('GET /mcp explains itself and leaks nothing', async () => {
    const r = await fetch(`${HTTP}/mcp`);
    expect(r.status).toBe(405);
    const t = await r.text();
    expect(t).toMatch(/Streamable HTTP/);
  });

  it('browser connects; a lab id alone, or a wrong secret, grants nothing', async () => {
    const b = browser(labId, secret);
    b.client.start();
    await b.waitFor('online');
    // right lab id, wrong secret
    const wrong = await rpc(`${labId}.${newSecret()}`, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBe('invalid_key');
    // a different browser claiming the same lab id with another secret is rejected
    const intruder = browser(labId, newSecret());
    intruder.client.start();
    await intruder.waitFor('rejected');
    intruder.client.stop();
    // the real browser is unaffected
    expect(b.client.state).toBe('online');
    b.client.stop();
  });

  it('initialize negotiates, teaches (instructions), and lists the coarse tool surface', async () => {
    const lab2 = newLabId();
    const sec2 = newSecret();
    const b = browser(lab2, sec2);
    b.client.start();
    await b.waitFor('online');
    const k = bearer({ labId: lab2, secret: sec2, createdAt: 0 });
    const init = await rpc(k, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-agent', version: '1' }, capabilities: {} } });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.serverInfo.name).toBe('docker-world');
    expect(init.json.result.instructions).toMatch(/whale/);
    expect(init.json.result.instructions).toMatch(/not a little VM|NOT "Docker"|level 3/i);
    // the browser is told an agent said hello
    for (let i = 0; i < 40 && b.mcp.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(b.mcp).toContain('test-agent');
    // notification: 202 without body
    const note = await fetch(`${HTTP}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    const list = await rpc(k, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names: string[] = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(TOOLS.map((t) => t.name));
    expect(names.length).toBeLessThanOrEqual(15);
    expect(names).toContain('world_mutate');
    expect(list.json.result.tools.find((t: { name: string }) => t.name === 'world_mutate').description).toMatch(/set_resource_limit/);
    // unknown method / tool
    expect((await rpc(k, { jsonrpc: '2.0', id: 3, method: 'nope' })).json.error.code).toBe(-32601);
    expect((await rpc(k, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'set_whale_x', arguments: {} } })).json.error.code).toBe(-32602);
    b.client.stop();
  });

  it('MCP can inspect the world, mutate it, and the browser world actually changes', async () => {
    const lab3 = newLabId();
    const sec3 = newSecret();
    const b = browser(lab3, sec3);
    b.client.start();
    await b.waitFor('online');
    const k = bearer({ labId: lab3, secret: sec3, createdAt: 0 });
    const ov = parse(await call(k, 'world_inspect'));
    expect(ov.containers.map((c: { target: string }) => c.target)).toEqual(['container:web']);
    expect(ov.online.agentConnected).toBe(true);

    // connection test: Santa waves
    const t = parse(await call(k, 'world_connection_test'));
    expect(t.ok).toBe(true);
    expect(b.engine.cues.some((c) => c.kind === 'wave')).toBe(true);

    // mutate through MCP -> browser world changes
    const m = parse(await call(k, 'world_mutate', { action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '6MB' }));
    expect(m.ok).toBe(true);
    expect(m.causalChain).toMatch(/memory\.max/);
    expect(b.engine.world.containers.web!.oomKilled).toBe(true);
    expect(b.engine.steps[b.engine.steps.length - 1]!.source).toBe('ai');

    // the learner acts in the browser -> MCP sees it in the event stream and user activity
    b.engine.dispatch({ action: 'start_container', target: 'container:web' }, 'user');
    b.engine.setView({ level: 3 }, 'user');
    const ua = parse(await call(k, 'world_inspect', { scope: 'user_activity' }));
    expect(ua.activity.some((a: { kind: string; summary: string }) => a.kind === 'level' && /level to 3/.test(a.summary))).toBe(true);
    expect(ua.activity.some((a: { summary: string }) => /docker start web/.test(a.summary))).toBe(true);
    const evs = parse(await call(k, 'world_inspect', { scope: 'events', limit: 5 }));
    expect(evs.events.length).toBeGreaterThan(0);
    const sel = parse(await call(k, 'world_inspect', { scope: 'view' }));
    expect(sel.level).toBe(3);

    // errors are returned as tool errors, not transport errors
    const bad = await call(k, 'world_mutate', { action: 'set_whale_x', value: 700 });
    expect(bad.json.result.isError).toBe(true);

    // rewind through MCP restores the browser's earlier world
    parse(await call(k, 'world_rewind', { back: 2 }));
    expect(b.engine.world.containers.web!.limits.memoryMB).toBeNull();
    b.client.stop();
  });

  it('a closed tab yields a graceful world_offline answer; reopening reconnects the same lab', async () => {
    const lab4 = newLabId();
    const sec4 = newSecret();
    const k = bearer({ labId: lab4, secret: sec4, createdAt: 0 });
    const b = browser(lab4, sec4);
    b.client.start();
    await b.waitFor('online');
    expect(parse(await call(k, 'world_inspect')).containers).toHaveLength(1);
    b.client.stop();
    await new Promise((r) => setTimeout(r, 300));
    const off = await call(k, 'world_inspect');
    expect(off.json.result.isError).toBe(true);
    const body = parse(off);
    expect(body.error).toBe('world_offline');
    expect(body.message).toMatch(/Ask the learner to open/);
    // protocol-level calls still work offline so clients can finish connecting
    expect((await rpc(k, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(200);
    // same stored identity reconnects
    const again = browser(lab4, sec4);
    again.client.start();
    await again.waitFor('online');
    expect(parse(await call(k, 'world_inspect')).containers).toHaveLength(1);
    again.client.stop();
  });

  it('opening the lab in a second tab replaces the first', async () => {
    const lab5 = newLabId();
    const sec5 = newSecret();
    const a = browser(lab5, sec5);
    a.client.start();
    await a.waitFor('online');
    const b = browser(lab5, sec5);
    b.client.start();
    await b.waitFor('online');
    await a.waitFor('replaced');
    a.client.stop();
    b.client.stop();
  });

  it('the OFFICIAL MCP SDK client connects, lists tools, reads instructions and drives the browser world', async () => {
    const lab = newLabId();
    const sec = newSecret();
    const b = browser(lab, sec);
    b.client.start();
    await b.waitFor('online');
    const client = new Client({ name: 'official-sdk-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${HTTP}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer({ labId: lab, secret: sec, createdAt: 0 })}` } } });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('docker-world');
    expect(client.getInstructions()).toMatch(/whale/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.find((t) => t.name === 'world_mutate')!.description).toMatch(/ACTION MANUAL/);
    const test = (await client.callTool({ name: 'world_connection_test', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(test.isError).toBeFalsy();
    expect(b.engine.cues.some((c) => c.kind === 'wave')).toBe(true);
    const res = (await client.callTool({ name: 'world_mutate', arguments: { action: 'run_container', image: 'redis:7', name: 'sdk-cache', ports: ['6379:6379'] } })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0]!.text).ok).toBe(true);
    expect(b.engine.world.containers['sdk-cache']!.state).toBe('running');
    const bad = (await client.callTool({ name: 'world_mutate', arguments: { action: 'set_whale_x', value: 700 } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await client.close();
    b.client.stop();
  });
});
