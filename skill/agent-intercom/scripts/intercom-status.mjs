#!/usr/bin/env node
/**
 * intercom-status — línea de estado de Claude Code con el buzón de Agent Intercom de ESTE chat, sin preguntarle al agente:
 *
 *   📬 2 · ana/api · online            (2 mensajes pendientes)
 *   ana/api · offline · ✋ hold · 3 retenidos · ⏸ 1 pausada
 *
 * En ~/.claude/settings.json (install.mjs lo pone si no tienes otra línea de estado):
 *   "statusLine": { "type": "command", "command": "node \"~/.agentintercom/intercom-status.mjs\"" }
 * Para añadirla a tu línea actual: `--then "<tu comando>"` imprime primero la salida de tu comando y luego esta.
 *
 * Consulta el servidor como mucho cada 15 s por chat (caché en ~/.agentintercom/state) y nunca tarda más de ~2 s.
 * Sin llave, sin servidor o en un chat que no usa intercom, no imprime nada. Node ≥ 18.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentProcess, instanceOf, intercomKey, intercomUrl } from './intercom-proc.mjs';

const { values } = parseArgs({ options: { then: { type: 'string' }, url: { type: 'string' }, ttl: { type: 'string' } } });
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* sin entrada */
}
let input = {};
try {
  input = JSON.parse(raw || '{}');
} catch {
  /* sin datos */
}

let prefix = '';
if (values.then) {
  try {
    prefix = execSync(values.then, { input: raw, encoding: 'utf8', timeout: 3000, windowsHide: true }).trimEnd();
  } catch {
    /* la otra línea falló: se muestra solo la nuestra */
  }
}
const print = (text) => {
  process.stdout.write([prefix, text].filter(Boolean).join('  |  '));
  process.exit(0);
};

const key = intercomKey();
const base = intercomUrl(values.url);
const chatId = String(input.session_id ?? '').slice(0, 100);
if (!key || !base || !chatId) print('');

const ttl = Math.max(5, Number(values.ttl ?? 15) || 15) * 1000;
const stateDir = join(homedir(), '.agentintercom', 'state');
const stateFile = join(stateDir, 'status.json');
let state = { chats: {} };
try {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch {
  /* primera vez */
}
const chat = state.chats[chatId] ?? {};
if (chat.at && Date.now() - chat.at < ttl) print(chat.text ?? '');

chat.instance ??= instanceOf(agentProcess('cc'));
let text = chat.text ?? '';
if (chat.instance) {
  try {
    const res = await fetch(`${base}/v1/tools/get_node_status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'X-Session-Instance': chat.instance, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    const j = await res.json();
    if (res.status === 404) text = ''; // este chat no usa intercom
    else if (res.status === 409) text = 'intercom: sin nombre';
    else if (j.ok) {
      const r = j.result;
      const pending = r.inbox?.pending ?? 0;
      const pol = r.inboundPolicy ?? {};
      const paused = r.pausedConversations?.length ?? 0;
      text = [
        `${pending ? `📬 ${pending} · ` : ''}${r.identity.address}`,
        r.session?.presence ?? '',
        pol.inbound && pol.inbound !== 'auto' ? `${pol.inbound === 'hold' ? '✋' : '⛔'} ${pol.inbound}` : '',
        pol.heldPending ? `${pol.heldPending} retenido(s)` : '',
        paused ? `⏸ ${paused} pausada(s)` : '',
      ].filter(Boolean).join(' · ');
    }
  } catch {
    /* servidor lento o caído: se deja el último texto */
  }
}
state.chats[chatId] = { ...chat, at: Date.now(), text };
for (const [id, c] of Object.entries(state.chats)) if (Date.now() - (c.at ?? 0) > 2 * 86_400_000) delete state.chats[id];
try {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
  renameSync(`${stateFile}.tmp`, stateFile);
} catch {
  /* sin caché: se consulta otra vez la próxima */
}
print(text);
