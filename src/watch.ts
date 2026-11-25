#!/usr/bin/env node
/**
 * intercom-watch — vigilante de buzón. Imprime UNA línea por mensaje nuevo de una sesión y mantiene su stream SSE
 * abierto (la sesión figura «online»). Un agente inactivo no se despierta solo; esto sí le avisa si su cliente lee la
 * salida de un proceso en segundo plano (p. ej. el Monitor de Claude Code).
 *
 * Por seguridad NO imprime el contenido del mensaje (entraría en el contexto del agente como texto de un tercero):
 * solo quién, cuándo y de qué tipo. El agente lo lee con check_inbox. `--preview N` muestra los primeros N caracteres.
 *
 *   AGENT_INTERCOM_KEY=aik_… node src/watch.ts --url https://intercom.example.com --session proyecto-a
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    session: { type: 'string' },
    preview: { type: 'string' },
    'wait-ms': { type: 'string' },
    'no-presence': { type: 'boolean' },
    once: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log('Uso: AGENT_INTERCOM_KEY=aik_… node src/watch.ts --url <https://servidor> --session <nombre> [--preview N] [--once] [--no-presence]');
  process.exit(0);
}

const base = (values.url ?? process.env.INTERCOM_URL ?? '').replace(/\/+$/, '').replace(/\/mcp$/, '');
const key = values.key ?? process.env.AGENT_INTERCOM_KEY ?? '';
const session = values.session ?? process.env.INTERCOM_SESSION ?? 'default';
const preview = Math.max(0, Math.min(500, Number(values.preview ?? 0) || 0));
const waitMs = Math.max(1000, Math.min(25000, Number(values['wait-ms'] ?? 25000) || 25000));
if (!base || !key) {
  console.error('Faltan --url (o INTERCOM_URL) y la clave (AGENT_INTERCOM_KEY; mejor por entorno que por argumento).');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${key}`, 'X-Session-Name': session, 'X-Session-Harness': 'intercom-watch' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string, n: number) =>
  [...s].map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 || c === 0x2028 || c === 0x2029 ? " " : ch; }).join("").replace(/ +/g, " ").trim().slice(0, n);

async function call(tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/v1/tools/${tool}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (res.status === 401) {
    console.error('La clave fue rechazada (401). Revisa AGENT_INTERCOM_KEY.');
    process.exit(2);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? 5) * 1000;
    throw Object.assign(new Error('limitado (429)'), { wait });
  }
  return (await res.json()) as { ok: boolean; result?: any; error?: { code: string; message: string } };
}

/** Mantiene abierto el stream SSE: es lo que hace que la sesión figure «online». */
async function holdPresence(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${base}/mcp`, { headers: { ...headers, Accept: 'text/event-stream' } });
      if (res.status === 401) return;
      if (res.ok && res.body) for await (const _ of res.body) void _;
    } catch {
      /* se reintenta */
    }
    await sleep(5000);
  }
}

async function main(): Promise<void> {
  const st = await call('get_node_status', {});
  if (!st.ok) {
    console.error(`No se pudo consultar el estado: ${st.error?.message}`);
    process.exit(2);
  }
  console.log(`[intercom] vigilando ${st.result.identity.address} (pendientes: ${st.result.inbox.pending})`);
  if (!values['no-presence'] && !values.once) void holdPresence();

  const seen = new Set<string>();
  let cursor: string | undefined;
  let backoff = 1000;
  for (;;) {
    try {
      const r = await call('check_inbox', { peek: true, waitMs: values.once ? 0 : waitMs, ...(cursor ? { afterId: cursor } : {}) });
      if (!r.ok) throw new Error(r.error?.message ?? 'error');
      backoff = 1000;
      for (const m of r.result.messages as Array<{ id: string; from: string; mode: string; kind: string; body: string; redelivered: boolean }>) {
        cursor = m.id;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const tipo = m.kind === 'channel' ? 'aviso de canal' : m.kind === 'human' ? 'respuesta de una persona' : m.mode;
        console.log(`[intercom] mensaje ${m.id} de ${clean(m.from, 80)} (${tipo}). Léelo con check_inbox${preview ? ` · «${clean(m.body, preview)}»` : ''}`);
      }
      if (values.once) return;
    } catch (e) {
      const wait = (e as { wait?: number }).wait ?? backoff;
      console.error(`[intercom] ${(e as Error).message}; reintento en ${Math.round(wait / 1000)} s`);
      backoff = Math.min(30000, backoff * 2);
      await sleep(wait);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
