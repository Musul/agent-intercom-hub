import { existsSync, statSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKey, hashKey } from './keys.ts';
import { all, audit, labelOf, one, run, type AgentRow, type Hub } from './store.ts';
import { AGENT_ID_RE, iso, newId, SESSION_NAME_RE, ToolError } from './util.ts';

/** Operaciones de administración (las usa la CLI; el servidor HTTP no las expone). */

export function addAgent(hub: Hub, id: string, displayName: string, kind = 'agent'): AgentRow {
  if (!AGENT_ID_RE.test(id)) throw new ToolError('bad_agent_id', 'El id usa minúsculas, números, punto, guion y guion bajo (máx. 48).');
  if (!['agent', 'human'].includes(kind)) throw new ToolError('bad_request', 'kind debe ser agent o human.');
  if (one(hub.db, 'SELECT 1 FROM agents WHERE id = ?', id)) throw new ToolError('agent_exists', `Ya existe el agente «${id}».`, undefined, 409);
  run(hub.db, 'INSERT INTO agents (id, display_name, kind, created_at) VALUES (?,?,?,?)', id, displayName || id, kind, Date.now());
  audit(hub, null, null, 'agent_added', id);
  return one<AgentRow>(hub.db, 'SELECT * FROM agents WHERE id = ?', id)!;
}

export interface NewKey {
  keyId: string;
  agentId: string;
  /** La clave en claro: solo existe aquí, en el momento de crearla. */
  key: string;
  pinnedSession: string | null;
}

/** Crea una clave para un agente. Con `pinnedSession` la clave solo sirve para esa sesión (una clave = una sesión). */
export function addKey(hub: Hub, agentId: string, opts: { label?: string; pinnedSession?: string; rawKey?: string } = {}): NewKey {
  if (!one(hub.db, 'SELECT 1 FROM agents WHERE id = ? AND disabled_at IS NULL', agentId)) throw new ToolError('unknown_agent', `No existe el agente «${agentId}».`, undefined, 404);
  if (opts.pinnedSession && !SESSION_NAME_RE.test(opts.pinnedSession)) throw new ToolError('bad_session_name', 'Nombre de sesión inválido.');
  const key = opts.rawKey ?? generateKey();
  if (key.length < 16) throw new ToolError('weak_key', 'La clave es demasiado corta (mínimo 16 caracteres).');
  const hash = hashKey(key);
  if (one(hub.db, 'SELECT 1 FROM api_keys WHERE key_hash = ?', hash)) throw new ToolError('key_exists', 'Esa clave ya está registrada.', undefined, 409);
  const keyId = newId('key');
  run(hub.db, 'INSERT INTO api_keys (id, agent_id, key_hash, label, pinned_session, created_at) VALUES (?,?,?,?,?,?)', keyId, agentId, hash, opts.label ?? null, opts.pinnedSession ?? null, Date.now());
  audit(hub, agentId, null, opts.rawKey ? 'key_imported' : 'key_added', keyId);
  return { keyId, agentId, key, pinnedSession: opts.pinnedSession ?? null };
}

export function revokeKey(hub: Hub, ref: string): { keyId: string } {
  const k = one<{ id: string; agent_id: string }>(hub.db, 'SELECT id, agent_id FROM api_keys WHERE (id = ? OR label = ?) AND revoked_at IS NULL', ref, ref);
  if (!k) throw new ToolError('unknown_key', `No hay una clave activa «${ref}».`, undefined, 404);
  run(hub.db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', Date.now(), k.id);
  audit(hub, k.agent_id, null, 'key_revoked', k.id);
  return { keyId: k.id };
}

export function disableAgent(hub: Hub, id: string): void {
  const r = run(hub.db, 'UPDATE agents SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL', Date.now(), id);
  if (!r.changes) throw new ToolError('unknown_agent', `No hay un agente activo «${id}».`, undefined, 404);
  audit(hub, null, null, 'agent_disabled', id);
}

export function listAgents(hub: Hub) {
  return all<AgentRow & { keys: number; sessions: number }>(
    hub.db,
    `SELECT a.*, (SELECT COUNT(*) FROM api_keys k WHERE k.agent_id = a.id AND k.revoked_at IS NULL) AS keys,
            (SELECT COUNT(*) FROM sessions s WHERE s.agent_id = a.id AND s.retired_at IS NULL) AS sessions
     FROM agents a ORDER BY a.id`,
  ).map((a) => ({ id: a.id, displayName: a.display_name, kind: a.kind, keys: a.keys, sessions: a.sessions, disabled: a.disabled_at !== null }));
}

export function listKeys(hub: Hub) {
  return all<{ id: string; agent_id: string; label: string | null; pinned_session: string | null; created_at: number; revoked_at: number | null; last_used_at: number | null }>(
    hub.db, 'SELECT * FROM api_keys ORDER BY agent_id, created_at',
  ).map((k) => ({ id: k.id, agentId: k.agent_id, label: k.label, pinnedSession: k.pinned_session, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), revoked: k.revoked_at !== null }));
}

export function listSessions(hub: Hub) {
  return all<{ id: string; agent_id: string; name: string; description: string; last_seen_at: number; retired_at: number | null }>(
    hub.db, 'SELECT id, agent_id, name, description, last_seen_at, retired_at FROM sessions ORDER BY agent_id, name',
  ).map((s) => ({ address: labelOf(s), sessionId: s.id, description: s.description, presence: hub.presence(s.id, s.last_seen_at, Date.now()), lastSeenAt: iso(s.last_seen_at), retired: s.retired_at !== null }));
}

export function retireSession(hub: Hub, address: string): void {
  const [agent, name] = address.split('/');
  const r = run(hub.db, 'UPDATE sessions SET retired_at = ? WHERE agent_id = ? AND name = ? AND retired_at IS NULL', Date.now(), agent ?? '', name ?? '');
  if (!r.changes) throw new ToolError('unknown_peer', `No hay una sesión activa «${address}».`, undefined, 404);
  audit(hub, agent ?? null, null, 'session_retired', address);
}

/** Limpieza periódica: mensajes ya cerrados, adjuntos y auditoría antiguos. */
export function maintenance(hub: Hub, now = Date.now()): { messages: number; attachments: number; audit: number; outputs: number } {
  const cutoff = now - hub.cfg.retentionDays * 86_400_000;
  const messages = Number(run(hub.db, `DELETE FROM messages WHERE state IN ('acknowledged','expired') AND created_at < ?`, cutoff).changes);
  const attachments = Number(run(hub.db, 'DELETE FROM attachments WHERE created_at < ?', cutoff).changes);
  const outputs = Number(run(hub.db, 'DELETE FROM outputs WHERE created_at < ?', cutoff).changes);
  const aud = Number(run(hub.db, 'DELETE FROM audit WHERE at < ?', now - 90 * 86_400_000).changes);
  return { messages, attachments, audit: aud, outputs };
}

/** Copia de seguridad consistente EN CALIENTE (`VACUUM INTO`): se puede hacer con el servidor en marcha. No pisa archivos. */
export function backup(hub: Hub, file: string): { file: string; bytes: number } {
  if (existsSync(file)) throw new ToolError('file_exists', `«${file}» ya existe; elige otro nombre (no se sobrescribe).`);
  try {
    hub.db.prepare('VACUUM INTO ?').run(file);
  } catch (e) {
    try {
      unlinkSync(file); // sin dejar una copia a medias
    } catch {
      /* no se llegó a crear */
    }
    throw new ToolError('backup_failed', `No se pudo crear la copia (${(e as Error).message}). Comprueba que el destino tiene espacio libre para toda la base y que no es un tmpfs pequeño.`);
  }
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const r = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (r.integrity_check !== 'ok') throw new ToolError('backup_corrupt', `La copia no pasó la comprobación: ${r.integrity_check}`);
  } finally {
    check.close();
  }
  return { file, bytes: statSync(file).size };
}
