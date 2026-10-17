import type { BrowserToRelay, RelayToBrowser } from '../../shared/tools';

/**
 * Browser <-> relay link. The browser is authoritative: the relay forwards MCP
 * tool calls here, we run them against the local world engine and answer.
 * The secret is sent in the first message (never in the URL).
 */

export type RelayState = 'connecting' | 'online' | 'offline' | 'replaced' | 'rejected';

export interface ToolAnswer {
  text: string;
  isError?: boolean;
}

export interface RelayOptions {
  /** e.g. wss://example.com  (no trailing slash) */
  base: string;
  lab: string;
  secret: string;
  onCall: (tool: string, args: Record<string, unknown>) => ToolAnswer | Promise<ToolAnswer>;
  onState?: (s: RelayState, detail?: string) => void;
  onMcp?: (client: string, at: number) => void;
  onReady?: (lastMcpAt: number | null) => void;
  /** injectable for tests */
  WebSocketImpl?: typeof WebSocket;
}

export class RelayClient {
  state: RelayState = 'offline';
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(private o: RelayOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.set('offline');
  }

  /** after being replaced by another tab, take the lab back */
  takeOver(): void {
    this.stopped = false;
    this.retry = 0;
    this.connect();
  }

  private set(s: RelayState, detail?: string): void {
    this.state = s;
    this.o.onState?.(s, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    const WS = this.o.WebSocketImpl ?? WebSocket;
    this.set('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(`${this.o.base}/ws?lab=${encodeURIComponent(this.o.lab)}`);
    } catch (e) {
      this.set('offline', String(e));
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.send({ t: 'hello', lab: this.o.lab, secret: this.o.secret, app: 'docker-world/1' });
    });
    ws.addEventListener('message', (ev) => {
      void this.onMessage(typeof ev.data === 'string' ? ev.data : '');
    });
    ws.addEventListener('close', (ev) => {
      if (this.ping) clearInterval(this.ping);
      if (ws !== this.ws) return;
      if (ev.code === 4409) this.set('replaced');
      else if (ev.code === 4401) this.set('rejected', ev.reason);
      else {
        this.set('offline');
        this.schedule();
      }
    });
    ws.addEventListener('error', () => {
      /* close follows */
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.min(15000, 800 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private send(m: BrowserToRelay): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private async onMessage(raw: string): Promise<void> {
    let m: RelayToBrowser;
    try {
      m = JSON.parse(raw) as RelayToBrowser;
    } catch {
      return;
    }
    switch (m.t) {
      case 'ready':
        this.retry = 0;
        this.set('online');
        this.o.onReady?.(m.lastMcpAt);
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ t: 'ping' }), 25000);
        break;
      case 'call': {
        let out: ToolAnswer;
        try {
          out = await this.o.onCall(m.tool, m.args ?? {});
        } catch (e) {
          out = { text: JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), isError: true };
        }
        this.send({ t: 'result', id: m.id, ok: true, value: out });
        break;
      }
      case 'mcp':
        this.o.onMcp?.(m.client, m.at);
        break;
      case 'error':
        if (m.code === 'bad_secret' || m.code === 'bad_hello') this.set('rejected', m.message);
        break;
      default:
        break;
    }
  }
}
