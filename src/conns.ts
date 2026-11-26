/**
 * Conexiones MCP con estado: una por chat abierto (cabecera Mcp-Session-Id).
 *
 * Un chat nuevo llega SIN nombre de sesión. El servidor se lo pide al usuario con un formulario MCP
 * (`elicitation/create`) en cuanto el cliente abre su stream; si el cliente no tiene formularios, el agente
 * pregunta en el chat y llama a `register_session`. Con la cabecera X-Session-Name (o una clave fijada) la
 * conexión nace ya nombrada, como antes; con X-Session-Instance, el mismo chat que reconecta recupera su nombre.
 */
import { ensureSession, type SessionMeta } from './peers.ts';
import { audit, labelOf, one, run, type AgentRow, type ConnRow, type Hub, type SessionRow } from './store.ts';
import { newId, norm, parseJson, SESSION_NAME_RE, ToolError } from './util.ts';

export interface InitInfo {
  clientName: string;
  clientVersion: string;
  capabilities: unknown;
  protocol: string;
}

export interface ConnHeaders {
  name?: string | undefined;
  pinned?: string | null | undefined;
  instance?: string | undefined;
  suggest?: string | undefined;
  cwd?: string | undefined;
  harness?: string | undefined;
  description?: string | undefined;
  channels?: number | null | undefined;
}

const TOUCH_EVERY_MS = 5000;
/** Conexiones a las que ya se les mandó el formulario y aún no contestan. */
const asking = new Set<string>();

/** Lo que escribe una persona como nombre («Sam API» → «sam-api»). */
export function slugName(raw: string): string {
  return norm(raw).trim().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 48);
}

const connById = (hub: Hub, id: string) => one<ConnRow>(hub.db, 'SELECT * FROM connections WHERE id = ?', id);
const liveSession = (hub: Hub, id: string) => one<SessionRow>(hub.db, 'SELECT * FROM sessions WHERE id = ? AND retired_at IS NULL', id);

/** El cliente puede mostrar formularios (elicitation en modo form). */
export function canElicit(conn: ConnRow): boolean {
  const e = parseJson<Record<string, unknown>>(conn.capabilities, {}).elicitation;
  if (!e || typeof e !== 'object') return false;
  const keys = Object.keys(e);
  return keys.length === 0 || keys.includes('form');
}

/** El cliente es Claude Code (el único que hoy entrega `notifications/claude/channel` al modelo). */
export const isClaudeCode = (conn: ConnRow): boolean => /claude[-_ ]?code/i.test(conn.client_name) || conn.harness === 'claude-code';

/** Nombre sugerido para el formulario: el que mandó el cliente o, si no, la carpeta del proyecto. */
export function suggestionOf(conn: ConnRow): string {
  const raw = conn.suggest ?? (conn.cwd ? conn.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '' : '');
  const s = slugName(raw);
  return SESSION_NAME_RE.test(s) ? s : '';
}

/** Alta de una conexión al recibir `initialize`. Si trae nombre (cabecera, clave fijada o mismo chat) nace nombrada. */
export function createConnection(hub: Hub, agent: AgentRow, keyId: string, init: InitInfo, h: ConnHeaders, now: number): ConnRow {
  const id = newId('con');
  run(
    hub.db,
    `INSERT INTO connections (id, agent_id, key_id, client_name, client_version, capabilities, protocol, instance, suggest, cwd, harness, channels, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, agent.id, keyId, init.clientName.slice(0, 80), init.clientVersion.slice(0, 40), JSON.stringify(init.capabilities ?? {}).slice(0, 4000),
    init.protocol.slice(0, 20), h.instance?.slice(0, 100) ?? null, h.suggest?.slice(0, 48) ?? null, h.cwd?.slice(0, 200) ?? null,
    h.harness?.slice(0, 40) ?? null, h.channels ?? null, now, now,
  );
  // Tope por agente: se borran las conexiones más viejas (un cliente que reconecta sin parar no llena la base).
  run(
    hub.db,
    'DELETE FROM connections WHERE id IN (SELECT id FROM connections WHERE agent_id = ? ORDER BY last_seen_at DESC, created_at DESC LIMIT -1 OFFSET ?)',
    agent.id, hub.cfg.maxConnectionsPerAgent,
  );
  let conn = connById(hub, id)!;
  const meta: SessionMeta = { description: h.description, harness: h.harness, cwd: h.cwd };
  const fixed = h.pinned ?? h.name;
  if (fixed) return bindConnection(hub, conn, agent, fixed, meta, { takeover: true }).conn;
  if (h.instance) {
    // El mismo chat que vuelve (reconexión, --resume): recupera su sesión y se cierran sus conexiones anteriores.
    const prev = one<{ session_id: string }>(
      hub.db,
      'SELECT session_id FROM connections WHERE agent_id = ? AND instance = ? AND id <> ? AND session_id IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1',
      agent.id, h.instance, id,
    );
    const s = prev ? liveSession(hub, prev.session_id) : undefined;
    for (const old of hub.db.prepare('SELECT id FROM connections WHERE agent_id = ? AND instance = ? AND id <> ? AND closed_at IS NULL').all(agent.id, h.instance, id) as { id: string }[]) {
      closeConnection(hub, old.id, now);
    }
    if (s) conn = bindConnection(hub, conn, agent, s.name, meta, { takeover: true }).conn;
  }
  return conn;
}

/** La conexión `id` del agente, si existe y sigue abierta. */
export function getConnection(hub: Hub, id: string, agentId: string): ConnRow | undefined {
  const c = connById(hub, id);
  return c && c.agent_id === agentId && c.closed_at === null ? c : undefined;
}

export function touchConnection(hub: Hub, conn: ConnRow, now: number): void {
  if (now - conn.last_seen_at > TOUCH_EVERY_MS) {
    run(hub.db, 'UPDATE connections SET last_seen_at = ? WHERE id = ?', now, conn.id);
    conn.last_seen_at = now;
  }
}

export function closeConnection(hub: Hub, id: string, now = Date.now()): void {
  run(hub.db, 'UPDATE connections SET closed_at = ? WHERE id = ? AND closed_at IS NULL', now, id);
  hub.endConnStreams(id);
}

/** ¿Hay OTRO chat abierto usando esta sesión? (no cuenta el mismo chat reconectando ni los vigilantes) */
function sessionBusy(hub: Hub, sessionId: string, conn: ConnRow, now: number): boolean {
  const others = hub.db
    .prepare('SELECT id, instance, last_seen_at FROM connections WHERE session_id = ? AND id <> ? AND closed_at IS NULL')
    .all(sessionId, conn.id) as { id: string; instance: string | null; last_seen_at: number }[];
  return others.some(
    (o) => !(o.instance && o.instance === conn.instance) && ((hub.connStreams.get(o.id)?.size ?? 0) > 0 || now - o.last_seen_at <= hub.cfg.recentMs),
  );
}

/**
 * Pone nombre a la conexión (crea la sesión si no existía, o retoma su buzón). Falla con `session_in_use` si ese
 * nombre está abierto en otro chat, salvo `takeover`. Al nombrarla se entregan los mensajes que esperaban.
 */
export function bindConnection(
  hub: Hub, conn: ConnRow, agent: AgentRow, rawName: string, meta: SessionMeta, opts: { takeover?: boolean; fromUser?: boolean } = {},
): { conn: ConnRow; session: SessionRow } {
  const name = opts.fromUser ? slugName(rawName) : rawName.trim().toLowerCase();
  if (!SESSION_NAME_RE.test(name)) {
    throw new ToolError('bad_session_name', 'Nombre no válido: usa minúsculas, números, punto, guion y guion bajo (máx. 48), p. ej. «sam-api».');
  }
  const now = Date.now();
  const existing = one<SessionRow>(hub.db, 'SELECT * FROM sessions WHERE agent_id = ? AND name = ? AND retired_at IS NULL', agent.id, name);
  if (existing && existing.id !== conn.session_id && !opts.takeover && sessionBusy(hub, existing.id, conn, now)) {
    throw new ToolError(
      'session_in_use',
      `«${agent.id}/${name}» ya está abierta en otro chat. Elige otro nombre (o usa takeover: true si ese chat ya se cerró).`,
      { address: `${agent.id}/${name}` },
      409,
    );
  }
  const session = ensureSession(hub, agent, name, meta, now);
  const from = conn.session_id;
  run(hub.db, `UPDATE connections SET session_id = ?, naming = 'named', last_seen_at = ? WHERE id = ?`, session.id, now, conn.id);
  hub.rebindStreams(conn.id, from, session.id);
  if (from !== session.id) audit(hub, agent.id, session.id, 'session_bound', `${conn.id} -> ${labelOf(session)}`);
  hub.deliver(session.id);
  return { conn: connById(hub, conn.id)!, session };
}

/**
 * Si la conexión no tiene nombre y el cliente admite formularios, le pide el nombre al usuario por su stream.
 * Hasta 3 intentos si el nombre no vale o está ocupado; si el usuario lo cierra, el agente lo pedirá en el chat.
 */
export function askName(hub: Hub, connId: string, attempt = 1, note = ''): void {
  const conn = connById(hub, connId);
  if (!conn || conn.closed_at !== null || conn.session_id || conn.naming === 'declined' || !canElicit(conn) || asking.has(conn.id)) return;
  const suggest = suggestionOf(conn);
  const p = hub.request(conn.id, 'elicitation/create', {
    message: `Agent Intercom: ¿cómo se llama esta sesión? Tus compañeros te escribirán a «${conn.agent_id}/<nombre>».${note ? ` ${note}` : ''}`,
    requestedSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          title: 'Nombre de la sesión',
          description: 'Minúsculas, números, punto, guion o guion bajo (p. ej. sam-api).',
          minLength: 1,
          maxLength: 48,
          ...(suggest ? { default: suggest } : {}),
        },
        description: { type: 'string', title: '¿En qué trabaja? (opcional)', maxLength: 300 },
      },
      required: ['name'],
    },
  });
  if (!p) return;
  asking.add(conn.id);
  run(hub.db, `UPDATE connections SET naming = 'asked' WHERE id = ?`, conn.id);
  void p.then((msg) => {
    asking.delete(conn.id);
    const fresh = connById(hub, conn.id);
    if (!fresh || fresh.closed_at !== null || fresh.session_id) return;
    const result = (msg.result ?? {}) as { action?: string; content?: Record<string, unknown> };
    if (msg.error || result.action !== 'accept') {
      run(hub.db, `UPDATE connections SET naming = 'declined' WHERE id = ?`, conn.id);
      return;
    }
    const agent = one<AgentRow>(hub.db, 'SELECT * FROM agents WHERE id = ? AND disabled_at IS NULL', fresh.agent_id);
    if (!agent) return;
    const description = typeof result.content?.description === 'string' ? result.content.description.slice(0, 300) : undefined;
    try {
      bindConnection(hub, fresh, agent, String(result.content?.name ?? ''), { description, cwd: fresh.cwd ?? undefined, harness: fresh.harness ?? undefined }, { fromUser: true });
      if (description) run(hub.db, `UPDATE sessions SET description = ? WHERE id = (SELECT session_id FROM connections WHERE id = ?)`, description, conn.id);
    } catch (e) {
      if (e instanceof ToolError && attempt < 3) {
        run(hub.db, `UPDATE connections SET naming = 'pending' WHERE id = ?`, conn.id);
        askName(hub, conn.id, attempt + 1, e.message);
      } else {
        run(hub.db, `UPDATE connections SET naming = 'declined' WHERE id = ?`, conn.id);
      }
    }
  });
}

/** Limpieza: conexiones cerradas o inactivas hace más de `connectionKeepDays`. */
export function purgeConnections(hub: Hub, now = Date.now()): number {
  const cutoff = now - hub.cfg.connectionKeepDays * 86_400_000;
  return Number(run(hub.db, 'DELETE FROM connections WHERE last_seen_at < ? OR (closed_at IS NOT NULL AND closed_at < ?)', cutoff, cutoff).changes);
}
