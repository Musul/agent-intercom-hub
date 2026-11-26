#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addAgent, addKey, backup, disableAgent, listAgents, listKeys, listSessions, maintenance, restoreBackup, retireSession, revokeKey, scheduledBackup, testRestore, verifyBackup } from './admin.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { answerQuestion, listQuestions } from './files.ts';
import { createInvite, listInvites, revokeInvite } from './invites.ts';
import { createWebLink, feed } from './web.ts';
import { Hub, all, one } from './store.ts';
import { ToolError } from './util.ts';

const HELP = `intercom — administración de agent-intercom-hub (opera directamente sobre la base: INTERCOM_DB)

  agent:add <id> [--name "Nombre visible"] [--kind agent|human]
  agent:list
  agent:disable <id>
  key:add <agente> [--label x] [--session nombre]     crea una clave (se muestra UNA vez);
                                                       con --session la clave solo sirve para esa sesión
  key:import <agente> --file ruta [--label x] [--session nombre]   registra una clave que ya existe (migración)
  key:list
  key:revoke <id|label>
  session:list
  session:retire <agente/sesion>
  question:list [--state open|answered]
  question:answer <id> "respuesta" [--by quien]
  invite:create <agente> [--label x] [--hours 48] [--url https://…]   enlace de un solo uso: la persona ejecuta
                                                       install.mjs --join <enlace> y su instalador recibe la llave
  invite:list
  invite:revoke <id>
  web:link <agente> [--url https://…]                  enlace de un solo uso (10 min) al panel web
  feed [--limit 50] [--follow]                         últimos mensajes entre sesiones (con --follow, en vivo)
  maintenance                                          limpia mensajes cerrados, adjuntos y auditoría antiguos
  backup <archivo>                                     copia consistente y verificada, en caliente (no sobrescribe)
  backup:now                                           copia en BACKUP_DIR con nombre fechado (y borra las antiguas)
  backup:verify <copia>                                integridad, versión de esquema y filas, sin tocar nada
  backup:test <copia>                                  ENSAYO de restauración en una carpeta temporal (no toca producción)
  restore <copia> [--force]                            restaura sobre INTERCOM_DB (servidor PARADO; --force aparta la actual)
  stats
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    kind: { type: 'string' },
    label: { type: 'string' },
    session: { type: 'string' },
    file: { type: 'string' },
    state: { type: 'string' },
    by: { type: 'string' },
    json: { type: 'boolean' },
    hours: { type: 'string' },
    url: { type: 'string' },
    limit: { type: 'string' },
    follow: { type: 'boolean' },
    force: { type: 'boolean' },
  },
});
const [cmd, ...args] = positionals;
if (!cmd || cmd === 'help') {
  console.log(HELP);
  process.exit(cmd ? 0 : 1);
}

const cfg = loadConfig();
const hub = new Hub(cfg, openDb(cfg.dbPath));
const show = (v: unknown) => (values.json ? console.log(JSON.stringify(v, null, 2)) : console.table(v));
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new ToolError('bad_request', `Falta ${what}. Ver: intercom help`);
  return v;
};

try {
  switch (cmd) {
    case 'agent:add': {
      const id = need(args[0], '<id>');
      const a = addAgent(hub, id, values.name ?? id, values.kind ?? 'agent');
      console.log(`Agente creado: ${a.id} (${a.display_name}). Ahora crea su clave:  intercom key:add ${a.id}`);
      break;
    }
    case 'agent:list':
      show(listAgents(hub));
      break;
    case 'agent:disable':
      disableAgent(hub, need(args[0], '<id>'));
      console.log('Agente desactivado (sus claves dejan de valer).');
      break;
    case 'key:add': {
      const k = addKey(hub, need(args[0], '<agente>'), { ...(values.label ? { label: values.label } : {}), ...(values.session ? { pinnedSession: values.session } : {}) });
      console.log(`Clave creada (${k.keyId}${k.pinnedSession ? `, fijada a la sesión «${k.pinnedSession}»` : ''}). Guárdala ahora: no se puede volver a ver.\n\n${k.key}\n`);
      break;
    }
    case 'key:import': {
      const raw = readFileSync(need(values.file, '--file <ruta>'), 'utf8').trim();
      const k = addKey(hub, need(args[0], '<agente>'), { rawKey: raw, ...(values.label ? { label: values.label } : {}), ...(values.session ? { pinnedSession: values.session } : {}) });
      console.log(`Clave importada (${k.keyId}) para ${k.agentId}.`);
      break;
    }
    case 'key:list':
      show(listKeys(hub));
      break;
    case 'key:revoke':
      revokeKey(hub, need(args[0], '<id|label>'));
      console.log('Clave revocada.');
      break;
    case 'session:list':
      show(listSessions(hub));
      break;
    case 'session:retire':
      retireSession(hub, need(args[0], '<agente/sesion>'));
      console.log('Sesión retirada (reaparece sola si vuelve a conectarse).');
      break;
    case 'question:list':
      show(listQuestions(hub, values.state));
      break;
    case 'question:answer':
      answerQuestion(hub, need(args[0], '<id>'), need(args[1], '"respuesta"'), values.by ?? 'cli');
      console.log('Respuesta enviada al buzón de la sesión.');
      break;
    case 'invite:create': {
      const inv = createInvite(hub, need(args[0], '<agente>'), {
        ...(values.label ? { label: values.label } : {}),
        ...(values.hours ? { hours: Number(values.hours) } : {}),
        ...(values.url ? { origin: values.url } : {}),
      });
      console.log(`Invitación ${inv.inviteId} para ${inv.agentId} (caduca ${inv.expiresAt}; sirve UNA vez).`);
      if (inv.url) console.log(`\nEnlace (mándalo por un canal privado):\n\n${inv.url}\n\nLa persona ejecuta, desde la carpeta skill/agent-intercom:\n  node scripts/install.mjs --client claude --join "${inv.url}"\n`);
      else console.log(`\nToken: ${inv.token}\n(Define PUBLIC_URL o pasa --url https://<servidor> para obtener el enlace completo: <url>/join#<token>)\n`);
      break;
    }
    case 'invite:list':
      show(listInvites(hub));
      break;
    case 'invite:revoke':
      revokeInvite(hub, need(args[0], '<id>'));
      console.log('Invitación anulada.');
      break;
    case 'web:link': {
      const origin = values.url ?? cfg.publicUrl;
      if (!origin) throw new ToolError('bad_request', 'Falta la URL pública: --url https://<servidor> o PUBLIC_URL.');
      const agentId = need(args[0], '<agente>');
      if (!one(hub.db, 'SELECT 1 FROM agents WHERE id = ? AND disabled_at IS NULL', agentId)) throw new ToolError('unknown_agent', `No existe el agente «${agentId}».`);
      const l = createWebLink(hub, agentId, origin.replace(/\/+$/, ''));
      console.log(`Enlace al panel para ${agentId} (un solo uso, caduca ${l.expiresAt}):\n${l.url}`);
      break;
    }
    case 'feed': {
      const line = (m: ReturnType<typeof feed>[number]) =>
        `${m.createdAt?.slice(5, 19).replace('T', ' ')}  ${m.from} → ${m.to}  [${m.kindLabel}${m.wake ? '' : ` · retenido: ${m.heldReason ?? '—'}`} · ${m.state}]  ${m.body.replace(/\s+/g, ' ').slice(0, 140)}`;
      let last = 0;
      for (const m of feed(hub, Number(values.limit ?? 50) || 50)) {
        console.log(line(m));
        last = m.rowid;
      }
      if (values.follow) {
        console.log('— siguiendo (Ctrl+C para salir) —');
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          for (const m of feed(hub, 200, last)) {
            console.log(line(m));
            last = m.rowid;
          }
        }
      }
      break;
    }
    case 'maintenance':
      console.log(maintenance(hub));
      break;
    case 'backup': {
      const r = backup(hub, need(args[0], '<archivo destino>'));
      console.log(`Copia consistente y verificada: ${r.file} (${r.bytes} bytes). Se puede hacer con el servidor en marcha.`);
      break;
    }
    case 'backup:now': {
      const r = scheduledBackup(hub);
      console.log(`Copia: ${r.file} (${r.bytes} bytes)${r.pruned ? `; ${r.pruned} antiguas borradas` : ''}.`);
      break;
    }
    case 'backup:verify':
      show(verifyBackup(need(args[0], '<copia>')));
      break;
    case 'backup:test': {
      const r = testRestore(need(args[0], '<copia>'));
      show(r);
      console.log('Ensayo de restauración correcto: la copia se abre, migra y se lee. Producción no se tocó.');
      break;
    }
    case 'restore': {
      hub.db.close();
      const r = restoreBackup(need(args[0], '<copia>'), cfg.dbPath, values.force === true);
      console.log(`Restaurada ${r.from} → ${r.restored} (esquema ${r.schema}). Arranca el servidor.`);
      process.exit(0);
    }
    case 'stats':
      show({
        agentes: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM agents')!.n,
        sesiones: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM sessions WHERE retired_at IS NULL')!.n,
        mensajes_pendientes: one<{ n: number }>(hub.db, `SELECT COUNT(*) n FROM messages WHERE state IN ('queued','delivered')`)!.n,
        canales: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM channels')!.n,
        tareas_abiertas: one<{ n: number }>(hub.db, `SELECT COUNT(*) n FROM tasks WHERE state <> 'done'`)!.n,
        sesiones_online: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM sessions WHERE retired_at IS NULL AND push_streams > 0')!.n,
        chats_abiertos: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM connections WHERE closed_at IS NULL AND last_seen_at >= ?', Date.now() - hub.cfg.recentMs)!.n,
      });
      break;
    default:
      console.error(`Comando desconocido: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
} catch (e) {
  if (e instanceof ToolError) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
} finally {
  if (hub.db.isOpen) hub.db.close();
}
