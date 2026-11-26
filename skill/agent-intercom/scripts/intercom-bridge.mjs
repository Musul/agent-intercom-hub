#!/usr/bin/env node
/**
 * intercom-bridge — puente MCP stdio → Agent Intercom (HTTP).
 *
 * Para clientes que no pueden añadir cabeceras dinámicas a un servidor MCP remoto (Antigravity): el cliente lo lanza
 * como servidor MCP local (stdio) y el puente habla con el hub añadiendo la llave, el id del chat
 * (X-Session-Instance, el mismo que usan los hooks), la carpeta y el cliente. Reenvía todo en los dos sentidos:
 * peticiones, respuestas, el formulario del nombre de sesión (elicitation) y los avisos del servidor.
 *
 *   { "command": "node", "args": ["<ruta>/intercom-bridge.mjs"] }      (con AGENT_INTERCOM_KEY en el entorno)
 *
 * Sin dependencias. Node ≥ 18. Los mensajes de diagnóstico van a stderr; stdout es solo JSON-RPC.
 */
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { agentProcess, ascii, instanceOf, intercomKey, intercomUrl, slug } from './intercom-proc.mjs';

const base = intercomUrl(process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : undefined);
const key = intercomKey();
const log = (...a) => console.error('[intercom-bridge]', ...a);
if (!base || !key) {
  log('Faltan la llave (AGENT_INTERCOM_KEY o ~/.agentintercom/agent.key) y la URL (AGENT_INTERCOM_URL o ~/.agentintercom/config.json).');
  process.exit(2);
}

const proc = agentProcess();
const instance = instanceOf(proc);
const headers = {
  Authorization: `Bearer ${key}`,
  'X-Session-Cwd': ascii(process.cwd()),
  'X-Session-Harness': process.env.INTERCOM_HARNESS || proc?.harness || 'mcp-bridge',
  'X-Session-Suggest': slug(basename(process.cwd())) || 'sesion',
  ...(instance ? { 'X-Session-Instance': instance } : {}),
  ...(process.env.INTERCOM_SESSION ? { 'X-Session-Name': slug(process.env.INTERCOM_SESSION) } : {}),
};

let sid = '';
let stopped = false;
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emitSse(text) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      out(JSON.parse(data));
    } catch {
      /* no es JSON-RPC */
    }
  }
}

/** Un mensaje del cliente → POST /mcp; lo que responda el hub, de vuelta al cliente. */
async function send(msg) {
  let res;
  try {
    res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
      body: JSON.stringify(msg),
    });
  } catch (e) {
    if (msg.id !== undefined && msg.method) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Agent Intercom no responde: ${e.message}` } });
    return;
  }
  const newSid = res.headers.get('mcp-session-id');
  if (newSid) sid = newSid;
  if (res.status === 202) return;
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return emitSse(text);
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* no es JSON */
  }
  if (body && (Array.isArray(body) || body.jsonrpc)) return void (Array.isArray(body) ? body : [body]).forEach(out);
  if (res.status === 404 && sid) log('El servidor perdió esta sesión MCP: reinicia el cliente.');
  if (msg.id !== undefined && msg.method) {
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Agent Intercom HTTP ${res.status}: ${body?.message ?? body?.error ?? text.slice(0, 200)}` } });
  }
}

/** Stream GET de la sesión: peticiones del servidor (formulario del nombre) y avisos. Se reabre si se corta. */
async function listen() {
  while (!stopped && sid) {
    try {
      const res = await fetch(`${base}/mcp`, { headers: { ...headers, Accept: 'text/event-stream', 'Mcp-Session-Id': sid } });
      if (res.status === 404 || res.status === 401) return log(`stream cerrado por el servidor (HTTP ${res.status})`);
      if (res.ok && res.body) {
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          const cut = buf.lastIndexOf('\n\n');
          if (cut === -1) continue;
          emitSse(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch {
      /* se reintenta */
    }
    await sleep(2000);
  }
}

// Hasta tener sesión MCP (initialize) los mensajes van en orden; luego, en paralelo (check_inbox puede esperar).
let ready = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return log('línea no JSON ignorada');
  }
  if (!sid) {
    ready = ready.then(() => send(msg));
  } else {
    void ready.then(() => send(msg));
  }
  if (msg.method === 'notifications/initialized') void ready.then(() => listen());
});
rl.on('close', async () => {
  stopped = true;
  await ready.catch(() => undefined);
  if (sid) {
    try {
      await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': sid }, signal: AbortSignal.timeout(3000) });
    } catch {
      /* da igual: el servidor lo cierra al cortarse el stream */
    }
  }
  process.exit(0);
});
