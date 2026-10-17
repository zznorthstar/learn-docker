import { DurableObject } from 'cloudflare:workers';
import type { BrowserToRelay, RelayToBrowser } from '../../shared/tools';
import { handleRpc, type ToolOut } from './mcp';

export interface Env {
  ASSETS: Fetcher;
  LAB: DurableObjectNamespace<Lab>;
  ALLOWED_ORIGINS?: string;
}

const CALL_TIMEOUT_MS = 20_000;
const MAX_WS_MESSAGE = 256 * 1024;

interface Attachment {
  authed: boolean;
}

interface Pending {
  resolve: (r: ToolOut) => void;
  timer: ReturnType<typeof setTimeout>;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** constant-time comparison of two equal-purpose hex digests */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * One Durable Object per lab. It is a rendezvous point, not a backend:
 * it stores ONLY sha256(secret) (to authenticate), keeps the live browser
 * WebSocket, and forwards MCP tool calls to it. The world lives in the browser.
 */
export class Lab extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // keep-alive pings are answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  /* ----------------------------------------------------------- browser socket */

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, m: RelayToBrowser): void {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      /* socket already gone */
    }
  }

  private authedSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Attachment | null)?.authed);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_WS_MESSAGE) {
      ws.close(1009, 'message too large or not text');
      return;
    }
    let m: BrowserToRelay;
    try {
      m = JSON.parse(raw) as BrowserToRelay;
    } catch {
      return;
    }
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { authed: false };
    if (!att.authed) {
      if (m.t !== 'hello') {
        ws.close(4400, 'say hello first');
        return;
      }
      await this.hello(ws, m);
      return;
    }
    if (m.t === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      const v = m.value as Partial<ToolOut> | undefined;
      p.resolve({
        text: m.ok && typeof v?.text === 'string' ? v.text : JSON.stringify({ ok: false, error: m.error ?? 'tool failed' }),
        isError: !m.ok || !!v?.isError,
      });
    }
  }

  private async hello(ws: WebSocket, m: Extract<BrowserToRelay, { t: 'hello' }>): Promise<void> {
    const name = this.ctx.id.name;
    if (typeof m.lab !== 'string' || (name && m.lab !== name) || typeof m.secret !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(m.secret)) {
      this.send(ws, { t: 'error', code: 'bad_hello', message: 'lab id or secret is malformed' });
      ws.close(4401, 'bad hello');
      return;
    }
    const h = await sha256Hex(m.secret);
    const stored = await this.ctx.storage.get<string>('secretHash');
    if (!stored) {
      // the first browser to present a (lab, secret) pair claims the lab
      await this.ctx.storage.put('secretHash', h);
    } else if (!safeEqual(stored, h)) {
      this.send(ws, { t: 'error', code: 'bad_secret', message: 'this lab id belongs to a different secret' });
      ws.close(4401, 'bad secret');
      return;
    }
    for (const other of this.authedSockets()) {
      if (other !== ws) {
        this.send(other, { t: 'error', code: 'replaced', message: 'this lab was opened in another tab' });
        other.close(4409, 'replaced');
      }
    }
    ws.serializeAttachment({ authed: true } satisfies Attachment);
    const lastMcpAt = (await this.ctx.storage.get<number>('lastMcpAt')) ?? null;
    this.send(ws, { t: 'ready', lastMcpAt });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    void ws;
    // if no authed browser remains, anyone waiting on a call gets an immediate offline answer
    if (this.authedSockets().filter((w) => w !== ws).length === 0) {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve(this.offline());
        this.pending.delete(id);
      }
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ----------------------------------------------------------------------- MCP */

  private origin = '';

  /** Called by the Worker for every MCP HTTP request. Returns the JSON-RPC response. */
  async mcp(secret: string, bodyJson: string, origin: string): Promise<{ status: number; body: string | null }> {
    this.origin = origin;
    const body: unknown = JSON.parse(bodyJson);
    const stored = await this.ctx.storage.get<string>('secretHash');
    if (!stored) return { status: 401, body: JSON.stringify({ error: 'unknown_lab', message: 'No browser has opened this lab yet. Open the site once, then connect your AI.' }) };
    if (!safeEqual(stored, await sha256Hex(secret))) return { status: 401, body: JSON.stringify({ error: 'invalid_key', message: 'The lab key is wrong.' }) };
    const msgs = Array.isArray(body) ? body : [body];
    const out: unknown[] = [];
    for (const m of msgs) {
      const r = await handleRpc(m as never, {
        callTool: (name, args) => this.callBrowser(name, args),
        onClient: (client) => this.noteClient(client),
      });
      if (r !== null) out.push(r);
    }
    if (out.length === 0) return { status: 202, body: null };
    return { status: 200, body: JSON.stringify(Array.isArray(body) ? out : out[0]) };
  }

  private noteClient(client: string): void {
    const at = Date.now();
    void this.ctx.storage.put('lastMcpAt', at);
    for (const ws of this.authedSockets()) this.send(ws, { t: 'mcp', status: 'connected', client, at });
  }

  private offline(): ToolOut {
    return {
      isError: true,
      text: JSON.stringify({
        ok: false,
        error: 'world_offline',
        message: `The learner's browser tab for this lab is not open right now, so the world cannot be reached. Ask the learner to open ${this.origin || 'the site'} in the browser where they created this lab; the lab is stored in that browser and reconnects automatically. Nothing was changed.`,
      }),
    };
  }

  private callBrowser(tool: string, args: Record<string, unknown>): Promise<ToolOut> {
    const ws = this.authedSockets()[0];
    if (!ws) return Promise.resolve(this.offline());
    const id = crypto.randomUUID();
    return new Promise<ToolOut>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ isError: true, text: JSON.stringify({ ok: false, error: 'browser_timeout', message: 'The learner\'s browser did not answer within 20 seconds (the tab may be in the background or frozen). Try again.' }) });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send(ws, { t: 'call', id, tool, args });
    });
  }
}
