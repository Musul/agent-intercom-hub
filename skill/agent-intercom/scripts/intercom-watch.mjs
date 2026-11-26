#!/usr/bin/env node
/**
 * intercom-watch — vigilante de buzón (entrega automática sin canales).
 *
 * Imprime UNA línea por mensaje nuevo de una sesión y mantiene abierto su stream como «oyente», así la sesión figura
 * online. Cada línea despierta al agente, que lee el mensaje con check_inbox.
 *
 * Dos formas de usarlo en Claude Code:
 *  - `--exit-on-message` con Bash en segundo plano (recomendado, sin límite de tiempo): termina en cuanto llega un
 *    mensaje que el agente aún no ha recogido; Claude Code despierta al agente al terminar el proceso; el agente lo
 *    atiende (check_inbox) y vuelve a lanzar el vigilante.
 *  - Sin esa opción, con el Monitor: una línea por mensaje, pero el Monitor se corta a los 30 minutos.
 *
 * Por seguridad NO imprime el contenido (entraría en el contexto del agente como texto de un tercero): solo quién,
 * cuándo y de qué tipo. `--preview N` muestra los primeros N caracteres.
 *
 *   AGENT_INTERCOM_KEY=aik_… node intercom-watch.mjs --url https://intercom.example.com --session sam-api
 *
 * Sin dependencias. Node ≥ 18.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    'exit-on-message': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log('Uso: AGENT_INTERCOM_KEY=aik_… node intercom-watch.mjs --url <https://servidor> --session <nombre> [--exit-on-message] [--preview N] [--once] [--no-presence]');
  process.exit(0);
}

/** URL que guardó el instalador (~/.agentintercom/config.json), si no se pasa otra. */
function savedUrl() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.agentintercom', 'config.json'), 'utf8')).url ?? '';
  } catch {
    return '';
  }
}
const base = (values.url ?? process.env.AGENT_INTERCOM_URL ?? process.env.INTERCOM_URL ?? savedUrl()).replace(/\/+$/, '').replace(/\/mcp$/, '');
function savedKey() {
  try {
    return readFileSync(join(homedir(), '.agentintercom', 'agent.key'), 'utf8').trim();
  } catch {
    return '';
  }
}
const key = values.key ?? process.env.AGENT_INTERCOM_KEY ?? savedKey();
const session = values.session ?? process.env.INTERCOM_SESSION ?? '';
const preview = Math.max(0, Math.min(500, Number(values.preview ?? 0) || 0));
const waitMs = Math.max(1000, Math.min(25000, Number(values['wait-ms'] ?? 25000) || 25000));
if (!base || !key || !session) {
  console.error('Faltan --url (o AGENT_INTERCOM_URL), --session (el nombre de TU sesión; get_node_status lo muestra) y la clave (AGENT_INTERCOM_KEY; mejor por entorno que por argumento).');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${key}`, 'X-Session-Name': session, 'X-Session-Harness': 'intercom-watch' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s, n) =>
  [...s].map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 || c === 0x2028 || c === 0x2029 ? ' ' : ch; }).join('').replace(/ +/g, ' ').trim().slice(0, n);

async function call(tool, args) {
  const res = await fetch(`${base}/v1/tools/${tool}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (res.status === 401) {
    console.error('La clave fue rechazada (401). Revisa AGENT_INTERCOM_KEY.');
    process.exit(2);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? 5) * 1000;
    throw Object.assign(new Error('limitado (429)'), { wait });
  }
  if (res.status === 404 && !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error('el servidor no expone /v1 (revisa el proxy)');
  }
  return res.json();
}

/** Mantiene abierto el stream como oyente: mientras viva, la sesión figura online. */
let stopping = false;
const presence = new AbortController();
async function holdPresence() {
  while (!stopping) {
    try {
      const res = await fetch(`${base}/mcp`, { headers: { ...headers, Accept: 'text/event-stream', 'X-Intercom-Listener': '1' }, signal: presence.signal });
      if (res.status === 401) return;
      if (res.ok && res.body) for await (const _ of res.body) void _;
    } catch {
      /* se reintenta */
    }
    if (!stopping) await sleep(5000);
  }
}

async function main() {
  const st = await call('get_node_status', {});
  if (!st.ok) {
    console.error(`No se pudo consultar el estado: ${st.error?.message}`);
    process.exit(2);
  }
  console.log(`[intercom] vigilando ${st.result.identity.address} (pendientes: ${st.result.inbox.pending})`);
  if (!values['no-presence'] && !values.once) void holdPresence();

  const seen = new Set();
  let cursor;
  let backoff = 1000;
  for (;;) {
    try {
      const r = await call('check_inbox', { peek: true, waitMs: values.once ? 0 : waitMs, ...(cursor ? { afterId: cursor } : {}) });
      if (!r.ok) throw new Error(r.error?.message ?? 'error');
      backoff = 1000;
      let fresh = 0;
      for (const m of r.result.messages) {
        cursor = m.id;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        // con --exit-on-message solo cuenta lo que el agente aún no recogió (lo ya recogido no lo vuelve a despertar)
        if (values['exit-on-message'] && m.redelivered) continue;
        fresh++;
        const tipo = m.kind === 'channel' ? 'aviso de canal' : m.kind === 'human' ? 'respuesta de una persona' : m.mode;
        console.log(`[intercom] mensaje ${m.id} de ${clean(m.from, 80)} (${tipo}). Léelo con check_inbox${preview ? ` · «${clean(m.body, preview)}»` : ''}`);
      }
      if (values.once || (values['exit-on-message'] && fresh > 0)) {
        // Se termina cerrando el stream y dejando vaciarse el proceso (process.exit con un fetch abierto revienta en Windows).
        stopping = true;
        presence.abort();
        return;
      }
    } catch (e) {
      const wait = e.wait ?? backoff;
      console.error(`[intercom] ${e.message}; reintento en ${Math.round(wait / 1000)} s`);
      backoff = Math.min(30000, backoff * 2);
      await sleep(wait);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
