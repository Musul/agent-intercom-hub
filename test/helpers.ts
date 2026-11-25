import type { AddressInfo } from 'node:net';
import { addAgent, addKey } from '../src/admin.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createHttpServer } from '../src/http.ts';
import { Hub } from '../src/store.ts';

export interface Booted {
  hub: Hub;
  base: string;
  /** Crea un agente con una clave y devuelve la clave. */
  agent(id: string, name?: string): string;
  close(): Promise<void>;
}

export async function boot(over: Partial<Config> = {}): Promise<Booted> {
  const cfg = loadConfig({}, { dbPath: ':memory:', host: '127.0.0.1', ...over });
  const hub = new Hub(cfg, openDb(':memory:'));
  const server = createHttpServer(hub);
  server.unref(); // un test que falla a medias no deja el proceso colgado
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    hub,
    base,
    agent(id, name) {
      addAgent(hub, id, name ?? id);
      return addKey(hub, id).key;
    },
    async close() {
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      hub.db.close();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const j = (r: Response): Promise<any> => r.json();

export const auth = (key: string, session?: string): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(session ? { 'X-Session-Name': session } : {}),
});

export async function rpc(base: string, key: string, session: string | undefined, method: string, params?: unknown, id: number | null = 1) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: auth(key, session), body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export interface ToolResult {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

/** Llama a una herramienta por MCP y devuelve su contenido estructurado. */
export async function tool(base: string, key: string, session: string | undefined, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { body } = await rpc(base, key, session, 'tools/call', { name, arguments: args });
  if (body.error) return { ok: false, data: body.error };
  return { ok: !body.result.isError, data: body.result.isError ? body.result.structuredContent.error : body.result.structuredContent };
}
