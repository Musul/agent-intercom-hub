#!/usr/bin/env node
/**
 * Conecta tu cliente a Agent Intercom.
 *
 *   node install.mjs --client claude --join "https://intercom.example.com/join#aii_…"     ← alta en un paso
 *   node install.mjs --client claude|codex|opencode|antigravity|pi --url https://intercom.example.com
 *
 * --join      canjea la invitación (un solo uso) por tu llave y la guarda SOLO para tu usuario en
 *             ~/.agentintercom/agent.key. La URL sale del enlace. No hace falta variable de entorno ni reiniciar.
 * --ide-live  (Claude Code) en VS Code/IDE el agente mantiene un vigilante para recibir al instante; cuesta una llamada
 *             de herramienta por turno. Sin él, el IDE recibe al terminar cada turno y cuando escribes (como Codex).
 * --alias X   (Claude Code) nombre del atajo que abre Claude Code con el canal activo (por defecto claude-ic);
 *             --no-alias no lo crea. --no-statusline no pone la línea de estado del buzón.
 *
 * Siempre: copia los scripts a ~/.agentintercom/ (ruta fija) y guarda la URL en ~/.agentintercom/config.json.
 * Antes de tocar un archivo de configuración deja una copia (<archivo>.bak-<fecha>). Nunca escribe la llave en una
 * configuración ni la imprime. Node ≥ 18.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { saveKey } from './intercom-proc.mjs';

const { values } = parseArgs({
  options: {
    client: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' }, join: { type: 'string' },
    'ide-live': { type: 'boolean' }, alias: { type: 'string' }, 'no-alias': { type: 'boolean' }, 'no-statusline': { type: 'boolean' },
  },
});
const client = (values.client ?? '').toLowerCase().replace(/^agy$/, 'antigravity').replace(/^claude-code$/, 'claude');
// --join "https://servidor/join#aii_…": la URL del servidor sale del propio enlace.
let joinToken = '';
let joinOrigin = '';
if (values.join) {
  const raw = values.join.trim();
  joinToken = (/#?(aii_[\w-]+)\s*$/.exec(raw) ?? [])[1] ?? '';
  try {
    if (/^https?:\/\//.test(raw)) joinOrigin = new URL(raw).origin;
  } catch {
    /* enlace mal copiado */
  }
  if (!joinToken) {
    console.error('El enlace de --join no trae una invitación (debe terminar en #aii_…). Cópialo entero, entre comillas.');
    process.exit(2);
  }
}
const url = (values.url ?? (joinOrigin || process.env.AGENT_INTERCOM_URL) ?? '').replace(/\/+$/, '').replace(/\/mcp$/, '');
const CLIENTS = ['claude', 'codex', 'opencode', 'antigravity', 'pi'];
if (!CLIENTS.includes(client) || !/^https?:\/\//.test(url)) {
  console.error(`Uso: node install.mjs --client ${CLIENTS.join('|')} (--join "<enlace de invitación>" | --url https://<servidor>)`);
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

// 0. Invitación: se canjea UNA vez por la llave, que queda solo para este usuario (nunca se imprime).
if (joinToken) {
  let r;
  try {
    const res = await fetch(`${url}/v1/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: joinToken }), signal: AbortSignal.timeout(15_000) });
    r = await res.json();
  } catch (e) {
    console.error(`No pude contactar con ${url} (${e.message}). Revisa la URL y tu conexión.`);
    process.exit(1);
  }
  if (!r?.ok) {
    console.error(`La invitación no sirvió: ${r?.error?.message ?? 'respuesta inesperada'}`);
    process.exit(1);
  }
  const file = saveKey(r.result.key);
  done.push(`llave de ${r.result.agentId} (${r.result.displayName}) guardada solo para tu usuario en ${file}`);
  // Codex y OpenCode leen la llave de la variable de entorno: en Windows se fija para el usuario (abre una terminal nueva).
  if (process.platform === 'win32' && (client === 'codex' || client === 'opencode')) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::SetEnvironmentVariable('AGENT_INTERCOM_KEY', (Get-Content -Raw \"$env:USERPROFILE\\.agentintercom\\agent.key\").Trim(), 'User')"], { stdio: 'ignore', windowsHide: true });
      done.push('variable de usuario AGENT_INTERCOM_KEY (para Codex/OpenCode; cierra y abre la app)');
    } catch {
      console.log('\nNo pude fijar AGENT_INTERCOM_KEY; Codex/OpenCode la necesitan (ver CONECTAR.md).');
    }
  }
}

// 1. Scripts y URL
mkdirSync(ih, { recursive: true });
for (const f of readdirSync(here)) if (f.endsWith('.mjs') && !f.startsWith('install')) copyFileSync(join(here, f), join(ih, f));
let prevConfig = {};
try {
  prevConfig = JSON.parse(readFileSync(join(ih, 'config.json'), 'utf8'));
} catch {
  /* primera vez */
}
const ideLive = values['ide-live'] === true || (values['ide-live'] === undefined && prevConfig.ideLive === true && client === 'claude');
writeFileSync(join(ih, 'config.json'), `${JSON.stringify({ ...prevConfig, url, ideLive }, null, 2)}\n`);
done.push(`scripts y URL en ${ih}${ideLive ? ' (modo en vivo en el IDE)' : ''}`);
const script = (f) => fwd(join(ih, f));
const hookCmd = (c, event) => `node "${script('intercom-hook.mjs')}" --client ${c} --event ${event}`;

// 2. El cliente
if (client === 'claude') {
  // La llave la pone el headersHelper al conectar (de la variable o de ~/.agentintercom/agent.key). La cabecera fija solo
  // queda como respaldo: con Authorization presente, Claude Code no intenta OAuth si algo falla (no dispara fail2ban).
  const config = {
    type: 'http',
    url: `${url}/mcp`,
    headers: { Authorization: 'Bearer ${AGENT_INTERCOM_KEY:-sin-llave}' },
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
  // Hooks: el vigilante arranca solo (terminal: asyncRewake; VS Code/IDE: el agente lo lanza al empezar y un hook Stop
  // no le deja terminar un turno sin relanzarlo).
  const settingsFile = join(home, '.claude', 'settings.json');
  const watch = script('intercom-watch.mjs');
  const rewake = { type: 'command', command: `node "${watch}" --hook-rewake`, asyncRewake: true, timeout: 86400 };
  const context = { type: 'command', command: `node "${watch}" --hook-context`, timeout: 20 };
  // Turno del usuario y fin de turno: reanuda conversaciones pausadas, entrega lo retenido y (en el IDE sin modo en vivo) lo demás.
  const turn = (ev) => ({ type: 'command', command: `node "${script('intercom-hook.mjs')}" --client claude --event ${ev}`, timeout: 15 });
  const ours = (h) => /intercom-watch\.mjs|intercom-hook\.mjs"? --client claude/.test(String(h.command ?? ''));
  const status = { type: 'command', command: `node "${script('intercom-status.mjs')}"` };
  try {
    const settings = readJson(settingsFile, {});
    settings.hooks ??= {};
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const list = (settings.hooks[ev] ?? []).map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(h)) } : g));
      settings.hooks[ev] = [...list.filter((g) => !Array.isArray(g.hooks) || g.hooks.length), { hooks: ev === 'UserPromptSubmit' ? [rewake, turn(ev)] : [rewake, context, turn(ev)] }];
    }
    if (!values['no-statusline'] && !settings.statusLine) {
      settings.statusLine = status;
      done.push('línea de estado con tu buzón (📬)');
    } else if (!values['no-statusline'] && !String(settings.statusLine?.command ?? '').includes('intercom-status')) {
      console.log(`\nYa tienes una línea de estado. Para añadir el buzón de intercom, cambia su comando por:\n  node "${script('intercom-status.mjs')}" --then "<tu comando actual>"`);
    }
    writeJson(settingsFile, settings);
  } catch (e) {
    manual(settingsFile, e.message, JSON.stringify({ hooks: { SessionStart: [{ hooks: [rewake, context, turn('SessionStart')] }], UserPromptSubmit: [{ hooks: [rewake, turn('UserPromptSubmit')] }], Stop: [{ hooks: [rewake, context, turn('Stop')] }] }, statusLine: status }, null, 2));
  }
  const alias = values['no-alias'] ? null : installAlias(values.alias ?? 'claude-ic', `claude --dangerously-load-development-channels server:${server}`);
  console.log([
    '',
    'Abre un chat NUEVO: tomará como nombre de sesión tu repo (y la rama si no es la principal); solo te pregunta si ese nombre ya está abierto en otro chat.',
    `Para recibir los mensajes al instante (online) abre Claude Code con el canal: ${alias ? `${alias}  (abre una terminal nueva para que exista)` : `claude --dangerously-load-development-channels server:${server}`}`,
    'En plan Team/Enterprise un Owner debe activar channelsEnabled en las managed settings; sin eso el vigilante hace de respaldo en la terminal.',
    ideLive ? 'VS Code: modo en vivo activado (el agente mantiene un vigilante; cuesta una llamada por turno).' : 'VS Code: recibes al terminar cada turno y cuando escribes (sin coste extra). Para recibir al instante: --ide-live.',
  ].join('\n'));
}

/** Atajo que abre Claude Code con el canal: un .cmd en ~/.agentintercom/bin (Windows, en el PATH del usuario) y un alias en bash/zsh. */
function installAlias(name, command) {
  if (!/^[\w.-]+$/.test(name)) {
    console.log(`\nNombre de alias no válido: ${name}`);
    return null;
  }
  const begin = '# >>> agent-intercom >>>';
  const end = '# <<< agent-intercom <<<';
  const putBlock = (file, body, create) => {
    if (!existsSync(file) && !create) return;
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const block = `${begin}\n${body}\n${end}`;
    const re = new RegExp(`${begin}[\\s\\S]*?${end}`);
    const next = re.test(cur) ? cur.replace(re, block) : `${cur.replace(/\s*$/, '')}${cur ? '\n\n' : ''}${block}\n`;
    if (next === cur) return;
    backup(file);
    writeFileSync(file, next);
    done.push(`alias ${name} en ${file}`);
  };
  if (process.platform === 'win32') {
    const bin = join(ih, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n${command} %*\r\n`);
    try {
      const ps = `$b = '${bin.replace(/'/g, "''")}'; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains $b)) { [Environment]::SetEnvironmentVariable('Path', ((@($p, $b) | Where-Object { $_ }) -join ';'), 'User') }`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
      done.push(`atajo ${name} (cmd y PowerShell) en ${bin}, añadido a tu PATH`);
    } catch {
      console.log(`\nNo pude añadir ${bin} a tu PATH: añádelo a mano para usar ${name}.`);
    }
  }
  const sh = `alias ${name}='${command}'`;
  const rcs = ['.bashrc', '.zshrc'].map((f) => join(home, f));
  const any = rcs.some((f) => existsSync(f));
  putBlock(rcs[0], sh, !any);
  putBlock(rcs[1], sh, false);
  return name;
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

console.log(`\nListo (${client}):\n- ${done.join('\n- ')}\n${joinToken ? 'Tu llave ya está guardada: no la copies a configs ni chats.' : 'Comprueba que tu llave está en ~/.agentintercom/agent.key (o en AGENT_INTERCOM_KEY). Mejor aún: pide una invitación y usa --join. Nunca la escribas en configs ni chats.'}`);
