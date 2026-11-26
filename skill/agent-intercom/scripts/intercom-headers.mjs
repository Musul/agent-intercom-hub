#!/usr/bin/env node
/**
 * intercom-headers — cabeceras dinámicas por chat para Agent Intercom.
 *
 * Claude Code lo ejecuta al conectar el servidor MCP (`headersHelper`) y Codex como `http_headers_helper`, en la
 * carpeta del proyecto. Imprime un JSON {cabecera: valor}:
 *
 *   X-Session-Suggest   nombre sugerido para el formulario (la carpeta del proyecto, p. ej. «sam-api»)
 *   X-Session-Cwd       carpeta del proyecto (ayuda a que te encuentren con list_peers)
 *   X-Session-Harness   claude-code | codex | …
 *   X-Session-Instance  id del chat (proceso del cliente): reconexiones y hooks del mismo chat dan con su sesión
 *   X-Intercom-Channels 1/0: si este Claude Code se lanzó con el canal del intercom activo (entrega automática)
 *   X-Session-Name      SOLO si defines INTERCOM_SESSION: nombre fijo, sin formulario
 *
 * No imprime ni lee la clave (va aparte, en Authorization). Sin dependencias. Node ≥ 18.
 */
import { basename } from 'node:path';
import { agentProcess, ascii, instanceOf, slug } from './intercom-proc.mjs';

const env = process.env;
const cwd = process.cwd();
const proc = agentProcess();
const harness = env.INTERCOM_HARNESS || proc?.harness || (env.CLAUDE_CODE_MCP_SERVER_NAME ? 'claude-code' : '');

const h = { 'X-Session-Cwd': ascii(cwd) };
if (harness) h['X-Session-Harness'] = harness;
const suggest = slug(basename(cwd));
if (suggest) h['X-Session-Suggest'] = suggest;
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
