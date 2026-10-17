import { Lab, type Env } from './lab';

export { Lab };

const LAB_ID = /^w_[a-z0-9]{6,24}$/;
const BEARER = /^Bearer\s+(w_[a-z0-9]{6,24})\.([A-Za-z0-9_-]{32,64})$/;
const MAX_BODY = 64 * 1024;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

function allowedOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return true; // non-browser clients
  const self = new URL(req.url).origin;
  if (origin === self) return true;
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/mcp':
        return mcp(req, env, url);
      case '/ws':
        return ws(req, env, url);
      case '/health':
        return json({ ok: true, service: 'docker-world' });
      default:
        return env.ASSETS.fetch(req);
    }
  },
} satisfies ExportedHandler<Env>;

/** Streamable-HTTP MCP endpoint. Auth: `Authorization: Bearer <labId>.<secret>`. */
async function mcp(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET' || req.method === 'DELETE') {
    return json(
      {
        service: 'Docker World MCP endpoint',
        transport: 'Streamable HTTP (POST JSON-RPC)',
        auth: 'Authorization: Bearer <labId>.<secret>  (shown on the site, in the Connect dialog)',
        note: 'This endpoint has no session state; open the site, then add this URL to your AI client.',
      },
      405,
      { ...CORS, Allow: 'POST, OPTIONS' },
    );
  }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, CORS);
  const auth = BEARER.exec(req.headers.get('Authorization') ?? '');
  if (!auth) {
    return json({ error: 'unauthorized', message: 'Send the header  Authorization: Bearer <labId>.<secret>  (copy it from the site\'s Connect dialog).' }, 401, { ...CORS, 'WWW-Authenticate': 'Bearer realm="docker-world"' });
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'payload_too_large' }, 413, CORS);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400, CORS);
  }
  const [, lab, secret] = auth;
  const stub = env.LAB.getByName(lab!);
  const r = await stub.mcp(secret!, JSON.stringify(body), url.origin);
  if (r.status === 202 || r.body === null) return new Response(null, { status: 202, headers: CORS });
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
}

/** Browser relay socket: the secret travels inside the first message, never in the URL. */
async function ws(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket upgrade', { status: 426 });
  if (!allowedOrigin(req, env)) return new Response('origin not allowed', { status: 403 });
  const lab = url.searchParams.get('lab') ?? '';
  if (!LAB_ID.test(lab)) return new Response('bad lab id', { status: 400 });
  return env.LAB.getByName(lab).fetch(req);
}
