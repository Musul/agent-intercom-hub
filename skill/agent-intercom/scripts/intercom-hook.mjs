#!/usr/bin/env node
/**
 * intercom-hook — entrega los mensajes de Agent Intercom en Codex y Antigravity mediante sus hooks.
 *
 * Estos clientes no permiten meter un mensaje en un chat abierto desde fuera, así que el mensaje entra en el siguiente
 * momento en que el cliente ejecuta un hook:
 *   Codex:       SessionStart y UserPromptSubmit (como contexto) · Stop (el agente sigue y lo atiende)
 *   Antigravity: SessionStart y PreInvocation (como mensaje del sistema) · Stop (el agente sigue y lo atiende)
 *
 *   node intercom-hook.mjs --client codex --event Stop
 *   node intercom-hook.mjs --client antigravity --event PreInvocation
 *
 * Encuentra la sesión de su chat por el mismo id que manda la conexión MCP (X-Session-Instance, proceso del cliente).
 * Entrega cada mensaje una sola vez por chat. Nunca bloquea al agente: ante cualquier error responde «nada nuevo».
 * Necesita AGENT_INTERCOM_KEY (o ~/.agentintercom/agent.key); la URL sale de AGENT_INTERCOM_URL o de ~/.agentintercom/config.json. Node ≥ 18.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentProcess, instanceOf, intercomKey, intercomUrl, messageNote } from './intercom-proc.mjs';

const { values } = parseArgs({ options: { client: { type: 'string' }, event: { type: 'string' }, url: { type: 'string' } } });
const client = values.client === 'antigravity' || values.client === 'agy' ? 'antigravity' : 'codex';
const event = values.event ?? 'Stop';

function done(text) {
  let out = {};
  if (text) {
    if (client === 'codex') {
      out = event === 'Stop' ? { decision: 'block', reason: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
    } else {
      out = event === 'Stop' ? { decision: 'continue', reason: text } : { injectSteps: [{ systemMessage: { systemMessage: text } }] };
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  /* sin entrada */
}
const key = intercomKey();
const base = intercomUrl(values.url);
if (!key || !base) done();

// Estado por chat: su id de instancia (calcularlo cuesta ~1 s en Windows) y los mensajes ya entregados.
const chatId = String(input.session_id ?? input.conversationId ?? '').slice(0, 100);
const stateDir = join(homedir(), '.agentintercom', 'state');
const stateFile = join(stateDir, `hooks-${client}.json`);
let state = { chats: {} };
try {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch {
  /* primera vez */
}
const chat = (chatId && state.chats[chatId]) || { instance: null, seen: [] };
chat.instance ??= instanceOf(agentProcess(client === 'codex' ? 'cx' : 'agy'));
if (!chat.instance) done();

let messages = [];
try {
  const res = await fetch(`${base}/v1/tools/check_inbox`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Session-Instance': chat.instance, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 20 }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await res.json();
  if (j.ok) messages = j.result.messages.filter((m) => !chat.seen.includes(m.id));
} catch {
  /* sin red o servidor caído: el agente sigue como si nada */
}

chat.seen = [...chat.seen, ...messages.map((m) => m.id)].slice(-300);
chat.at = Date.now();
if (chatId) {
  state.chats[chatId] = chat;
  // los chats de hace más de una semana se olvidan
  for (const [id, c] of Object.entries(state.chats)) if (Date.now() - (c.at ?? 0) > 7 * 86_400_000) delete state.chats[id];
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
  } catch {
    /* sin estado: como mucho se repite un aviso */
  }
}
if (!messages.length) done();
done(
  [
    `Te ${messages.length === 1 ? 'llegó 1 mensaje' : `llegaron ${messages.length} mensajes`} por Agent Intercom. Atiéndelos ahora y luego sigue con lo que estabas haciendo.`,
    ...messages.map((m) => messageNote(m, m.to)),
  ].join('\n\n'),
);
