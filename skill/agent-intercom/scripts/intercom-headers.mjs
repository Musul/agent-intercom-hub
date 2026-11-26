#!/usr/bin/env node
/**
 * intercom-headers — cabeceras dinámicas por chat para Agent Intercom.
 *
 * Claude Code lo ejecuta al conectar el servidor MCP (`headersHelper`) en la carpeta del proyecto; Codex lo admite
 * como `http_headers_helper`. Imprime un JSON {cabecera: valor}:
 *
 *   X-Session-Suggest   nombre sugerido para el formulario (la carpeta del proyecto, p. ej. «sam-api»)
 *   X-Session-Cwd       carpeta del proyecto (ayuda a que te encuentren con list_peers)
 *   X-Session-Harness   claude-code | codex | …
 *   X-Session-Instance  id del chat (Claude Code): si el MCP reconecta o retomas el chat, recupera su nombre sin preguntar
 *   X-Intercom-Channels 1/0: si este Claude Code se lanzó con el canal del intercom activo (entrega automática)
 *   X-Session-Name      SOLO si defines INTERCOM_SESSION: nombre fijo, sin formulario
 *
 * No imprime ni lee la clave (va aparte, en Authorization: Bearer ${AGENT_INTERCOM_KEY}).
 * Sin dependencias. Node ≥ 18.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const env = process.env;
const cwd = process.cwd();
const slug = (s) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 48);
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

const isClaude = !!(env.CLAUDE_CODE_MCP_SERVER_NAME || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDECODE);
const harness = env.INTERCOM_HARNESS || (isClaude ? 'claude-code' : env.CODEX_HOME || env.CODEX_SANDBOX ? 'codex' : '');
const h = { 'X-Session-Cwd': ascii(cwd) };
if (harness) h['X-Session-Harness'] = harness;
const suggest = slug(basename(cwd));
if (suggest) h['X-Session-Suggest'] = suggest;
if (env.INTERCOM_SESSION) h['X-Session-Name'] = slug(env.INTERCOM_SESSION);

const looksLikeClaude = (name, cmd) => /claude/i.test(name) || /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli/i.test(cmd);

/**
 * Sube por los procesos padre (el helper corre bajo un shell) hasta el proceso de Claude Code y devuelve su pid,
 * cuándo arrancó y su línea de comandos. Con eso: un id estable del chat y si trae el canal activo.
 */
function claudeProcess() {
  try {
    if (process.platform === 'win32') {
      const ps = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}"`,
        'for ($i = 0; $i -lt 6 -and $p; $i++) {',
        "  if ($p.Name -match 'claude' -or $p.CommandLine -match '@anthropic-ai.claude-code|claude-code.cli') { break }",
        '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"',
        '}',
        "if ($p) { @{ pid = $p.ProcessId; name = $p.Name; created = $p.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss'); cmd = $p.CommandLine } | ConvertTo-Json -Compress }",
      ].join('\n');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      const p = out ? JSON.parse(out) : null;
      return p && looksLikeClaude(p.name ?? '', p.cmd ?? '') ? p : null;
    }
    let pid = process.ppid;
    for (let i = 0; i < 6 && pid > 1; i++) {
      // ppid, hora de arranque (lstart: 5 palabras) y la línea de comandos
      const line = execFileSync('ps', ['-o', 'ppid=', '-o', 'lstart=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
      const parts = line.split(/\s+/);
      const cmd = parts.slice(6).join(' ');
      if (looksLikeClaude(parts[6] ?? '', cmd)) {
        let created = parts.slice(1, 6).join(' ');
        if (process.platform === 'linux') {
          try {
            created = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; // starttime
          } catch {
            /* se queda lstart */
          }
        }
        return { pid, created, cmd };
      }
      pid = Number(parts[0]);
    }
  } catch {
    /* sin datos: el servidor usará lo de siempre */
  }
  return null;
}

const cc = harness === 'claude-code' ? claudeProcess() : null;
if (cc) h['X-Session-Instance'] = `cc-${cc.pid}-${String(cc.created).replace(/\W+/g, '')}`.slice(0, 100);

if (env.INTERCOM_CHANNELS === '1' || env.INTERCOM_CHANNELS === '0') {
  h['X-Intercom-Channels'] = env.INTERCOM_CHANNELS;
} else if (cc?.cmd) {
  const server = env.CLAUDE_CODE_MCP_SERVER_NAME || 'agent_intercom';
  h['X-Intercom-Channels'] = /--(dangerously-load-development-)?channels\b/.test(cc.cmd) && cc.cmd.includes(`server:${server}`) ? '1' : '0';
}

process.stdout.write(JSON.stringify(h));
