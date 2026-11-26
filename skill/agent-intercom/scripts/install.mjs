#!/usr/bin/env node
/**
 * Conecta tu cliente a Agent Intercom.
 *
 *   node install.mjs --client claude|codex|opencode|antigravity|pi --url https://intercom.example.com
 *
 * Siempre: copia los scripts a ~/.agentintercom/ (ruta fija) y guarda la URL en ~/.agentintercom/config.json.
 * Antes de tocar un archivo de configuración deja una copia (<archivo>.bak-<fecha>). No lee ni escribe la llave:
 * va en la variable AGENT_INTERCOM_KEY (o en ~/.agentintercom/agent.key, ver CONECTAR.md). Node ≥ 18.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { client: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' } } });
const client = (values.client ?? '').toLowerCase().replace(/^agy$/, 'antigravity').replace(/^claude-code$/, 'claude');
const url = (values.url ?? process.env.AGENT_INTERCOM_URL ?? '').replace(/\/+$/, '').replace(/\/mcp$/, '');
const CLIENTS = ['claude', 'codex', 'opencode', 'antigravity', 'pi'];
if (!CLIENTS.includes(client) || !/^https?:\/\//.test(url)) {
  console.error(`Uso: node install.mjs --client ${CLIENTS.join('|')} --url https://<servidor>`);
  process.exit(2);
}

const server = values.name ?? 'agent_intercom';
const here = dirname(fileURLToPath(import.meta.url)); // .../agent-intercom/scripts
const skillDir = dirname(here);
const home = homedir();
const ih = join(home, '.agentintercom');
const fwd = (p) => p.replace(/\\/g, '/');
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const done = [];

function backup(file) {
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak-${stamp}`);
    done.push(`copia: ${file}.bak-${stamp}`);
  }
}
function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw); // si tiene comentarios (JSONC) falla y se explica qué añadir a mano
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  backup(file);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  done.push(`actualizado: ${file}`);
}
function manual(file, what, snippet) {
  console.log(`\nNo pude editar ${file} automáticamente (${what}). Añade esto a mano:\n${snippet}\n`);
}

// 1. Scripts y URL
mkdirSync(ih, { recursive: true });
for (const f of readdirSync(here)) if (f.endsWith('.mjs') && !f.startsWith('install')) copyFileSync(join(here, f), join(ih, f));
writeFileSync(join(ih, 'config.json'), `${JSON.stringify({ url }, null, 2)}\n`);
done.push(`scripts y URL en ${ih}`);
const script = (f) => fwd(join(ih, f));
const hookCmd = (c, event) => `node "${script('intercom-hook.mjs')}" --client ${c} --event ${event}`;

// 2. El cliente
if (client === 'claude') {
  const config = {
    type: 'http',
    url: `${url}/mcp`,
    headers: { Authorization: 'Bearer ${AGENT_INTERCOM_KEY}' },
    headersHelper: `node "${script('intercom-headers.mjs')}"`,
  };
  const claude = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    execFileSync(claude, ['mcp', 'remove', server, '--scope', 'user'], { stdio: 'ignore' });
  } catch {
    /* no existía */
  }
  execFileSync(claude, ['mcp', 'add-json', server, JSON.stringify(config), '--scope', 'user'], { stdio: 'inherit' });
  cpSync(skillDir, join(home, '.claude', 'skills', 'agent-intercom'), { recursive: true });
  done.push('MCP agent_intercom (scope user) y skill en ~/.claude/skills');
  // Hooks: el vigilante arranca solo (terminal: asyncRewake; VS Code/IDE: el agente lo lanza en su primera respuesta).
  const settingsFile = join(home, '.claude', 'settings.json');
  const watch = script('intercom-watch.mjs');
  const rewake = { type: 'command', command: `node "${watch}" --hook-rewake`, asyncRewake: true, timeout: 86400 };
  const context = { type: 'command', command: `node "${watch}" --hook-context`, timeout: 15 };
  try {
    const settings = readJson(settingsFile, {});
    settings.hooks ??= {};
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const list = (settings.hooks[ev] ?? []).map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !String(h.command ?? '').includes('intercom-watch.mjs')) } : g));
      settings.hooks[ev] = [...list.filter((g) => !Array.isArray(g.hooks) || g.hooks.length), { hooks: ev === 'SessionStart' ? [rewake, context] : [rewake] }];
    }
    writeJson(settingsFile, settings);
  } catch (e) {
    manual(settingsFile, e.message, JSON.stringify({ hooks: { SessionStart: [{ hooks: [rewake, context] }], UserPromptSubmit: [{ hooks: [rewake] }], Stop: [{ hooks: [rewake] }] } }, null, 2));
  }
  console.log(`\nAbre un chat NUEVO: te pedirá el nombre de la sesión. Para recibir los mensajes solos (online):\n  claude --dangerously-load-development-channels server:${server}`);
}

if (client === 'codex') {
  const toml = join(home, '.codex', 'config.toml');
  const block = [
    `[mcp_servers.${server}]`,
    `url = "${url}/mcp"`,
    'bearer_token_env_var = "AGENT_INTERCOM_KEY"',
    `http_headers_helper = 'node "${script('intercom-headers.mjs')}"'`,
  ].join('\n');
  const current = existsSync(toml) ? readFileSync(toml, 'utf8') : '';
  if (current.includes(`[mcp_servers.${server}]`)) {
    manual(toml, `ya tiene [mcp_servers.${server}]; revísalo`, block);
  } else {
    mkdirSync(dirname(toml), { recursive: true });
    backup(toml);
    writeFileSync(toml, `${current.replace(/\s*$/, '')}\n\n${block}\n`);
    done.push(`actualizado: ${toml}`);
  }
  const hooksFile = join(home, '.codex', 'hooks.json');
  try {
    const hooks = readJson(hooksFile, {});
    hooks.hooks ??= {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const list = (hooks.hooks[event] ??= []);
      const has = list.some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes('intercom-hook.mjs')));
      if (!has) list.push({ hooks: [{ type: 'command', command: hookCmd('codex', event), timeout: 15 }] });
    }
    writeJson(hooksFile, hooks);
  } catch (e) {
    manual(hooksFile, e.message, `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":${JSON.stringify(hookCmd('codex', 'Stop'))},"timeout":15}]}]}} (y lo mismo para SessionStart y UserPromptSubmit)`);
  }
  cpSync(skillDir, join(home, '.codex', 'skills', 'agent-intercom'), { recursive: true });
  console.log('\nEn Codex, aprueba los hooks nuevos con /hooks (Codex no ejecuta hooks sin aprobarlos).');
}

if (client === 'opencode') {
  const file = join(home, '.config', 'opencode', 'opencode.json');
  const entry = { type: 'remote', url: `${url}/mcp`, oauth: false, headers: { Authorization: 'Bearer {env:AGENT_INTERCOM_KEY}', 'X-Session-Harness': 'opencode' } };
  try {
    const cfg = readJson(file, {});
    cfg.mcp ??= {};
    // Formato v2 (mcp.servers.<nombre>); si el archivo usa el antiguo (mcp.<nombre>), se respeta.
    const legacy = !cfg.mcp.servers && Object.values(cfg.mcp).some((v) => v && typeof v === 'object' && 'type' in v);
    if (legacy) cfg.mcp[server] = entry;
    else (cfg.mcp.servers ??= {})[server] = entry;
    writeJson(file, cfg);
  } catch (e) {
    manual(file, e.message, JSON.stringify({ mcp: { servers: { [server]: entry } } }, null, 2));
  }
  const plugins = join(home, '.config', 'opencode', 'plugins');
  mkdirSync(plugins, { recursive: true });
  copyFileSync(join(skillDir, 'clients', 'opencode', 'agent-intercom.js'), join(plugins, 'agent-intercom.js'));
  done.push(`plugin en ${plugins}`);
  console.log('\nCierra y vuelve a abrir OpenCode (también la app de escritorio) para que cargue el plugin y la variable AGENT_INTERCOM_KEY.');
}

if (client === 'antigravity') {
  const dir = join(home, '.gemini', 'config');
  const mcpFile = join(dir, 'mcp_config.json');
  const entry = { command: 'node', args: [script('intercom-bridge.mjs')] };
  try {
    const cfg = readJson(mcpFile, {});
    (cfg.mcpServers ??= {})[server] = entry;
    writeJson(mcpFile, cfg);
  } catch (e) {
    manual(mcpFile, e.message, JSON.stringify({ mcpServers: { [server]: entry } }, null, 2));
  }
  const hooksFile = join(dir, 'hooks.json');
  const spec = Object.fromEntries(['SessionStart', 'PreInvocation', 'Stop'].map((ev) => [ev, [{ type: 'command', command: hookCmd('antigravity', ev), timeout: 15 }]]));
  try {
    const hooks = readJson(hooksFile, {});
    hooks['agent-intercom'] = spec;
    writeJson(hooksFile, hooks);
  } catch (e) {
    manual(hooksFile, e.message, JSON.stringify({ 'agent-intercom': spec }, null, 2));
  }
  console.log('\nReinicia agy para que cargue el MCP (puente local) y los hooks.');
}

if (client === 'pi') {
  const ext = join(home, '.pi', 'agent', 'extensions');
  mkdirSync(ext, { recursive: true });
  copyFileSync(join(skillDir, 'clients', 'pi', 'agent-intercom.ts'), join(ext, 'agent-intercom.ts'));
  done.push(`extensión en ${ext}`);
  console.log('\nAbre pi: te pedirá el nombre de la sesión. /intercom-name <nombre> lo cambia.');
}

console.log(`\nListo (${client}):\n- ${done.join('\n- ')}\nComprueba que AGENT_INTERCOM_KEY existe en tu entorno (o en ~/.agentintercom/agent.key). Nunca la escribas en configs ni chats.`);
