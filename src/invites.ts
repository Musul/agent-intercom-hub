/**
 * Invitaciones de un solo uso: el operador crea una (`intercom invite:create ana`) y le pasa el enlace a la persona;
 * su instalador (`install.mjs --join <enlace>`) la canjea UNA vez por una llave nueva, que guarda solo para su usuario.
 * Así la llave nunca viaja por chat ni correo: lo que viaja es un enlace que caduca y deja de valer al usarse.
 */
import { createHash, randomBytes } from 'node:crypto';
import { addKey } from './admin.ts';
import { all, audit, one, run, type AgentRow, type Hub } from './store.ts';
import { iso, newId, ToolError } from './util.ts';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function createInvite(hub: Hub, agentId: string, opts: { label?: string; hours?: number; origin?: string } = {}) {
  const agent = one<AgentRow>(hub.db, 'SELECT * FROM agents WHERE id = ? AND disabled_at IS NULL', agentId);
  if (!agent) throw new ToolError('unknown_agent', `No existe el agente «${agentId}».`, undefined, 404);
  const hours = opts.hours ?? hub.cfg.inviteHours;
  if (!(hours > 0 && hours <= 24 * 30)) throw new ToolError('bad_request', 'La invitación dura entre unos minutos y 30 días (--hours).');
  const token = `aii_${randomBytes(24).toString('base64url')}`;
  const now = Date.now();
  const id = newId('inv');
  run(hub.db, 'INSERT INTO invites (id, agent_id, token_hash, label, created_at, expires_at) VALUES (?,?,?,?,?,?)', id, agent.id, hash(token), opts.label ?? null, now, now + hours * 3_600_000);
  audit(hub, agent.id, null, 'invite_created', id);
  const origin = (opts.origin ?? hub.cfg.publicUrl).replace(/\/+$/, '');
  return { inviteId: id, agentId: agent.id, token, url: origin ? `${origin}/join#${token}` : null, expiresAt: iso(now + hours * 3_600_000) };
}

/** Canjea una invitación por una llave nueva (una sola vez). */
export function redeemInvite(hub: Hub, token: string, ip: string) {
  if (!/^aii_[\w-]{20,80}$/.test(token)) throw new ToolError('invalid_invite', 'Invitación no válida.', undefined, 401);
  const now = Date.now();
  return hub.tx(() => {
    const inv = one<{ id: string; agent_id: string; label: string | null; expires_at: number; used_at: number | null }>(hub.db, 'SELECT * FROM invites WHERE token_hash = ?', hash(token));
    if (!inv || inv.used_at !== null || inv.expires_at <= now) throw new ToolError('invalid_invite', 'Invitación no válida, ya usada o caducada: pide otra al operador.', undefined, 401);
    const agent = one<AgentRow>(hub.db, 'SELECT * FROM agents WHERE id = ? AND disabled_at IS NULL', inv.agent_id);
    if (!agent) throw new ToolError('invalid_invite', 'La persona de esta invitación ya no está activa.', undefined, 401);
    const label = `${inv.label ?? 'invitacion'}-${new Date(now).toISOString().slice(0, 10)}-${inv.id.slice(-6)}`;
    const k = addKey(hub, agent.id, { label });
    run(hub.db, 'UPDATE invites SET used_at = ?, key_id = ? WHERE id = ?', now, k.keyId, inv.id);
    audit(hub, agent.id, null, 'invite_redeemed', `${inv.id} ${ip}`);
    return { agentId: agent.id, displayName: agent.display_name, key: k.key, keyId: k.keyId, label };
  });
}

export function listInvites(hub: Hub) {
  return all<{ id: string; agent_id: string; label: string | null; created_at: number; expires_at: number; used_at: number | null; key_id: string | null }>(
    hub.db, 'SELECT id, agent_id, label, created_at, expires_at, used_at, key_id FROM invites ORDER BY created_at DESC LIMIT 100',
  ).map((i) => ({
    id: i.id, agentId: i.agent_id, label: i.label, createdAt: iso(i.created_at), expiresAt: iso(i.expires_at),
    state: i.used_at ? 'usada' : i.expires_at <= Date.now() ? 'caducada' : 'pendiente', keyId: i.key_id,
  }));
}

export function revokeInvite(hub: Hub, id: string): void {
  const r = run(hub.db, 'UPDATE invites SET expires_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', Date.now(), id, Date.now());
  if (!r.changes) throw new ToolError('unknown_invite', `No hay una invitación pendiente «${id}».`, undefined, 404);
  audit(hub, null, null, 'invite_revoked', id);
}
