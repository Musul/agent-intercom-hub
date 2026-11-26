#!/usr/bin/env node
/**
 * intercom-headers — cabeceras dinámicas por chat para Agent Intercom.
 *
 * Claude Code lo ejecuta al conectar el servidor MCP (`headersHelper`) y Codex como `http_headers_helper`, en la
 * carpeta del proyecto. Imprime un JSON {cabecera: valor}:
 *
 *   Authorization       Bearer <llave>, leída de AGENT_INTERCOM_KEY o de ~/.agentintercom/agent.key AL CONECTAR: guardar la
 *                       llave (install.mjs --join) basta, sin variables de entorno ni reiniciar la terminal
 *   X-Session-Suggest   nombre sugerido: repo + rama si no es la principal (p. ej. «sam-api» o «sam-api-feat-login»)
 *   X-Session-Auto      1: el servidor usa la sugerencia como nombre si está libre (solo pregunta si choca).
 *                       INTERCOM_ASK_NAME=1 lo desactiva (siempre pregunta)
 *   X-Session-Tags      repo y rama, para que el reparto de tareas por etiquetas llegue a esta sesión
 *   X-Session-Description  «repo X · rama Y · cliente» (solo rellena si la sesión no tiene descripción)
 *   X-Session-Cwd       carpeta del proyecto (ayuda a que te encuentren con list_peers)
 *   X-Session-Harness   claude-code | codex | …
 *   X-Session-Instance  id del chat (proceso del cliente): reconexiones y hooks del mismo chat dan con su sesión
 *   X-Intercom-Channels 1/0: si este Claude Code se lanzó con el canal del intercom activo (entrega automática)
 *   X-Session-Name      SOLO si defines INTERCOM_SESSION: nombre fijo, sin formulario
 *
 * La llave solo va a la salida que lee el cliente (nunca a un log). INTERCOM_HELPER_NO_AUTH=1 no la incluye (si tu
 * configuración ya manda Authorization). Sin dependencias. Node ≥ 18.
 */
import { agentProcess, ascii, gitInfo, instanceOf, intercomKey, slug } from './intercom-proc.mjs';

const env = process.env;
const cwd = env.CLAUDE_PROJECT_DIR || process.cwd(); // los helpers de scope user pueden correr desde ~/.claude
const proc = agentProcess();
const harness = env.INTERCOM_HARNESS || proc?.harness || (env.CLAUDE_CODE_MCP_SERVER_NAME ? 'claude-code' : '');

const h = { 'X-Session-Cwd': ascii(cwd) };
if (env.INTERCOM_HELPER_NO_AUTH !== '1') {
  const key = intercomKey();
  if (key) h.Authorization = `Bearer ${key}`;
}
if (harness) h['X-Session-Harness'] = harness;
const git = gitInfo(cwd);
if (git.suggest) h['X-Session-Suggest'] = git.suggest;
if (env.INTERCOM_ASK_NAME !== '1') h['X-Session-Auto'] = '1';
if (git.tags.length) h['X-Session-Tags'] = git.tags.join(',');
h['X-Session-Description'] = ascii([`repo ${git.repo}`, git.branch ? `rama ${git.branch}` : '', harness].filter(Boolean).join(' - '));
if (env.INTERCOM_SESSION) h['X-Session-Name'] = slug(env.INTERCOM_SESSION);
const instance = instanceOf(proc);
if (instance) h['X-Session-Instance'] = instance;

if (env.INTERCOM_CHANNELS === '1' || env.INTERCOM_CHANNELS === '0') {
  h['X-Intercom-Channels'] = env.INTERCOM_CHANNELS;
} else if (proc?.kind === 'cc' && proc.cmd) {
  const server = env.CLAUDE_CODE_MCP_SERVER_NAME || 'agent_intercom';
  h['X-Intercom-Channels'] = /--(dangerously-load-development-)?channels\b/.test(proc.cmd) && proc.cmd.includes(`server:${server}`) ? '1' : '0';
}

process.stdout.write(JSON.stringify(h));
