#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addAgent, addKey, backup, disableAgent, listAgents, listKeys, listSessions, maintenance, retireSession, revokeKey } from './admin.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { answerQuestion, listQuestions } from './files.ts';
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
  maintenance                                          limpia mensajes cerrados, adjuntos y auditoría antiguos
  backup <archivo>                                     copia consistente y verificada, en caliente (no sobrescribe)
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
    case 'maintenance':
      console.log(maintenance(hub));
      break;
    case 'backup': {
      const r = backup(hub, need(args[0], '<archivo destino>'));
      console.log(`Copia consistente y verificada: ${r.file} (${r.bytes} bytes). Se puede hacer con el servidor en marcha.`);
      break;
    }
    case 'stats':
      show({
        agentes: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM agents')!.n,
        sesiones: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM sessions WHERE retired_at IS NULL')!.n,
        mensajes_pendientes: one<{ n: number }>(hub.db, `SELECT COUNT(*) n FROM messages WHERE state IN ('queued','delivered')`)!.n,
        canales: one<{ n: number }>(hub.db, 'SELECT COUNT(*) n FROM channels')!.n,
        tareas_abiertas: all(hub.db, `SELECT state, COUNT(*) n FROM tasks GROUP BY state`),
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
  hub.db.close();
}
