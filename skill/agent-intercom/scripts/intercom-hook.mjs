#!/usr/bin/env node
/**
 * intercom-hook — entrega los mensajes de Agent Intercom mediante los hooks del cliente (Claude Code, Codex, Antigravity).
 *
 * El mensaje entra en el siguiente momento en que el cliente ejecuta un hook:
 *   Claude Code: SessionStart y UserPromptSubmit (como contexto) · Stop (el agente sigue y lo atiende)
 *   Codex:       SessionStart y UserPromptSubmit (como contexto) · Stop (el agente sigue y lo atiende)
 *   Antigravity: SessionStart y PreInvocation (como mensaje del sistema) · Stop (el agente sigue y lo atiende)
 *
 *   node intercom-hook.mjs --client claude --event UserPromptSubmit
 *   node intercom-hook.mjs --client codex --event Stop
 *   node intercom-hook.mjs --client antigravity --event PreInvocation
 *
 * Turno humano (SessionStart, UserPromptSubmit): avisa al servidor (POST /v1/human-turn), que reanuda las conversaciones
 * pausadas por el freno de bucles y devuelve los mensajes RETENIDOS (política hold, tope por hora, remitente no permitido):
 * entran ahora, con lo que escribió el usuario. En Stop solo entra lo que puede despertar al agente.
 *
 * Claude Code con entrega en vivo (canal, vigilante de la terminal o `ideLive` en el IDE) ya recibe lo que despierta:
 * aquí solo entran los retenidos. Sin entrega en vivo (VS Code por defecto) funciona como Codex: sin gastar un turno
 * extra por mensaje ni relanzar vigilantes.
 *
 * Encuentra la sesión de su chat por el mismo id que manda la conexión MCP (X-Session-Instance, proceso del cliente).
 * Entrega cada mensaje una sola vez por chat. Nunca bloquea al agente: ante cualquier error responde «nada nuevo».
 * Necesita la llave (AGENT_INTERCOM_KEY o ~/.agentintercom/agent.key); la URL sale de AGENT_INTERCOM_URL o de
 * ~/.agentintercom/config.json. Node ≥ 18.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentProcess, instanceOf, intercomConfig, intercomKey, intercomUrl, messageNote } from './intercom-proc.mjs';

const { values } = parseArgs({ options: { client: { type: 'string' }, event: { type: 'string' }, url: { type: 'string' } } });
const client = values.client === 'antigravity' || values.client === 'agy' ? 'antigravity' : values.client === 'claude' ? 'claude' : 'codex';
const event = values.event ?? 'Stop';

function done(text) {
  let out = {};
  if (text) {
    if (client === 'antigravity') {
      out = event === 'Stop' ? { decision: 'continue', reason: text } : { injectSteps: [{ systemMessage: { systemMessage: text } }] };
    } else {
      out = event === 'Stop' ? { decision: 'block', reason: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
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

// Estado por chat: su id de instancia (calcularlo cuesta ~1 s en Windows), si recibe en vivo y los mensajes ya entregados.
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
if (!chat.instance) {
  const proc = agentProcess(client === 'codex' ? 'cx' : client === 'claude' ? 'cc' : 'agy');
  chat.instance = instanceOf(proc);
  if (client === 'claude') chat.channel = /--(dangerously-load-development-)?channels\b/.test(proc?.cmd ?? '') && (proc?.cmd ?? '').includes('server:');
}
if (!chat.instance) done();

const humanEvent = event === 'SessionStart' || event === 'UserPromptSubmit';
// Claude Code: ¿recibe en vivo? Canal activo, terminal (vigilante con asyncRewake) o modo en vivo del IDE pedido a mano.
const live = client === 'claude' && (chat.channel || process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' || intercomConfig().ideLive === true);
if (live && !humanEvent) done();

const headers = { Authorization: `Bearer ${key}`, 'X-Session-Instance': chat.instance, 'Content-Type': 'application/json' };
async function post(path, body = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return res.json();
}

let messages = [];
try {
  if (humanEvent) {
    const r = await post('/v1/human-turn');
    if (r.ok) messages.push(...r.result.messages);
  }
  if (!live) {
    const r = await post('/v1/tools/check_inbox', { limit: 20 });
    if (r.ok) messages.push(...r.result.messages);
  }
} catch {
  /* sin red o servidor caído: el agente sigue como si nada */
}
// Al terminar un turno solo entra lo que puede despertar: lo retenido espera a que el usuario escriba.
if (event === 'Stop') messages = messages.filter((m) => m.wake !== false);
const ids = new Set();
messages = messages.filter((m) => !chat.seen.includes(m.id) && !ids.has(m.id) && ids.add(m.id));

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
