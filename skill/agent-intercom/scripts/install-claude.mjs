#!/usr/bin/env node
/**
 * Conecta Claude Code a Agent Intercom (scope user, todos tus proyectos):
 *  1. copia intercom-headers.mjs e intercom-watch.mjs a ~/.agentintercom/ (ruta fija);
 *  2. guarda la URL del servidor en ~/.agentintercom/config.json (la usan el vigilante y la extensión de pi);
 *  3. registra el MCP `agent_intercom` con la clave por variable (${AGENT_INTERCOM_KEY}) y el headersHelper,
 *     SIN nombre de sesión fijo: cada chat nuevo te pedirá su nombre;
 *  4. copia la skill a ~/.claude/skills/agent-intercom.
 *
 *   node install-claude.mjs --url https://intercom.example.com
 *
 * No lee ni escribe la clave. Sin dependencias. Node ≥ 18.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, name: { type: 'string' }, 'no-skill': { type: 'boolean' } } });
const url = (values.url ?? process.env.AGENT_INTERCOM_URL ?? '').replace(/\/+$/, '').replace(/\/mcp$/, '');
if (!/^https?:\/\//.test(url)) {
  console.error('Uso: node install-claude.mjs --url https://<servidor>   (opcional: --name agent_intercom)');
  process.exit(2);
}
const server = values.name ?? 'agent_intercom';
const here = dirname(fileURLToPath(import.meta.url));
const home = join(homedir(), '.agentintercom');
mkdirSync(home, { recursive: true });
for (const f of ['intercom-headers.mjs', 'intercom-watch.mjs']) copyFileSync(join(here, f), join(home, f));
writeFileSync(join(home, 'config.json'), JSON.stringify({ url }, null, 2) + '\n');

const fwd = (p) => p.replace(/\\/g, '/');
const config = {
  type: 'http',
  url: `${url}/mcp`,
  headers: { Authorization: 'Bearer ${AGENT_INTERCOM_KEY}' },
  headersHelper: `node "${fwd(join(home, 'intercom-headers.mjs'))}"`,
};
const claude = process.platform === 'win32' ? 'claude.exe' : 'claude';
try {
  execFileSync(claude, ['mcp', 'remove', server, '--scope', 'user'], { stdio: 'ignore' });
} catch {
  /* no existía */
}
execFileSync(claude, ['mcp', 'add-json', server, JSON.stringify(config), '--scope', 'user'], { stdio: 'inherit' });

if (!values['no-skill']) {
  const dest = join(homedir(), '.claude', 'skills', 'agent-intercom');
  cpSync(dirname(here), dest, { recursive: true });
  console.log(`Skill copiada a ${dest}`);
}

console.log(`
Listo. Abre un chat NUEVO de Claude Code: te pedirá el nombre de la sesión.
Para que los mensajes te lleguen solos (online), lánzalo con el canal activo:
  claude --dangerously-load-development-channels server:${server}
Comprueba que la variable AGENT_INTERCOM_KEY existe en tu entorno (no la escribas en archivos).`);
