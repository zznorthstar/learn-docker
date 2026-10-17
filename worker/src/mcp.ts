import { PROTOCOL_VERSIONS, SERVER_INFO, SERVER_INSTRUCTIONS, TOOLS } from '../../shared/tools';

/**
 * Minimal MCP server over Streamable HTTP (stateless, JSON responses).
 * It implements just what clients need to list and call tools, and delegates
 * every tool call to `ctx.callTool` (which forwards to the learner's browser).
 */

export interface ToolOut {
  text: string;
  isError?: boolean;
}

export interface RpcContext {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOut>;
  /** an MCP client said hello (initialize); used for the "your AI is connected" UI */
  onClient(name: string): void;
}

interface RpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: RpcReq['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: RpcReq['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export const MAX_TEXT = 60_000;

export async function handleRpc(msg: RpcReq, ctx: RpcContext): Promise<unknown | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': {
      const want = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      const version = PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0]!;
      const client = (p.clientInfo as { name?: string } | undefined)?.name ?? 'an MCP client';
      ctx.onClient(client);
      return ok(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case 'tools/call': {
      const name = p.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
        return fail(msg.id, -32602, `Unknown tool: ${String(name)}. Available: ${TOOLS.map((t) => t.name).join(', ')}`);
      }
      const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
      const out = await ctx.callTool(name, args);
      let text = out.text;
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n…[truncated ${text.length - MAX_TEXT} chars: ask for a narrower scope or a smaller limit]`;
      return ok(msg.id, { content: [{ type: 'text', text }], isError: !!out.isError });
    }
    case 'resources/list':
      return ok(msg.id, { resources: [] });
    case 'resources/templates/list':
      return ok(msg.id, { resourceTemplates: [] });
    case 'prompts/list':
      return ok(msg.id, { prompts: [] });
    case 'logging/setLevel':
      return ok(msg.id, {});
    case 'completion/complete':
      return ok(msg.id, { completion: { values: [], hasMore: false } });
    default:
      if (msg.method.startsWith('notifications/') || isNotification) return null;
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
