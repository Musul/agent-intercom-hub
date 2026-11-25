import { all, audit, labelOf, one, run, type AgentRow, type Ctx, type Hub, type Presence, type SessionFull, type SessionRow } from './store.ts';
import { clamp, iso, newId, norm, parseJson, SESSION_NAME_RE, ToolError } from './util.ts';

export interface SessionMeta {
  description?: string | undefined;
  harness?: string | undefined;
  cwd?: string | undefined;
}

const TOUCH_EVERY_MS = 5000;

/**
 * Localiza (o crea) la sesión `name` del agente. Es lo que hace que una misma clave pueda tener varias
 * sesiones a la vez, cada una con su buzón.
 */
export function ensureSession(hub: Hub, agent: AgentRow, name: string, meta: SessionMeta, now: number): SessionRow {
  if (!SESSION_NAME_RE.test(name)) {
    throw new ToolError('bad_session_name', 'El nombre de sesión usa minúsculas, números, punto, guion y guion bajo (máx. 48).');
  }
  let row = one<SessionRow>(hub.db, 'SELECT * FROM sessions WHERE agent_id = ? AND name = ?', agent.id, name);
  if (!row) {
    const n = one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND retired_at IS NULL', agent.id)!.n;
    if (n >= hub.cfg.maxSessionsPerAgent) throw new ToolError('too_many_sessions', 'Este agente tiene demasiadas sesiones; retira alguna.', undefined, 429);
    const id = newId('ses');
    run(
      hub.db,
      `INSERT INTO sessions (id, agent_id, name, description, harness, cwd, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, agent.id, name, meta.description ?? '', meta.harness ?? null, meta.cwd ?? null, now, now,
    );
    audit(hub, agent.id, id, 'session_created', name);
    row = one<SessionRow>(hub.db, 'SELECT * FROM sessions WHERE id = ?', id)!;
    hub.lastTouch.set(id, now);
    return row;
  }
  const last = hub.lastTouch.get(row.id) ?? 0;
  // Las cabeceras solo RELLENAN lo que falta: lo que el agente fijó con set_session_info no se pisa en cada petición.
  const description = row.description === '' ? meta.description : undefined;
  const harness = row.harness == null ? meta.harness : undefined;
  const cwd = row.cwd == null ? meta.cwd : undefined;
  const fills = description !== undefined || harness !== undefined || cwd !== undefined;
  if (now - last > TOUCH_EVERY_MS || fills || row.retired_at) {
    run(
      hub.db,
      `UPDATE sessions SET last_seen_at = ?, retired_at = NULL, description = ?, harness = ?, cwd = ? WHERE id = ?`,
      now, description ?? row.description, harness ?? row.harness, cwd ?? row.cwd, row.id,
    );
    hub.lastTouch.set(row.id, now);
    row = one<SessionRow>(hub.db, 'SELECT * FROM sessions WHERE id = ?', row.id)!;
  }
  return row;
}

const SESSIONS_FULL = `
  SELECT s.*, a.display_name AS display_name, a.kind AS agent_kind
  FROM sessions s JOIN agents a ON a.id = s.agent_id
  WHERE s.retired_at IS NULL AND a.disabled_at IS NULL`;

export function sessionView(hub: Hub, s: SessionFull, selfId: string | null, now: number) {
  const presence = hub.presence(s.id, s.last_seen_at, now);
  return {
    id: labelOf(s),
    agentId: s.agent_id,
    displayName: s.display_name,
    kind: s.agent_kind,
    session: s.name,
    sessionId: s.id,
    description: s.description,
    tags: parseJson<string[]>(s.tags, []),
    harness: s.harness,
    cwd: s.cwd,
    statusText: s.status_text,
    lifecycle: s.lifecycle,
    presence,
    // `ready`: hay alguien atendiendo ahora o hace poco. `reachable`: el mensaje queda en cola aunque no esté.
    ready: presence !== 'away',
    reachable: true,
    lastSeenAt: iso(s.last_seen_at),
    registeredAt: iso(s.created_at),
    self: s.id === selfId,
  };
}

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'en', 'un', 'una', 'the', 'of', 'a', 'to', 'con', 'para', 'sesion', 'session']);

/**
 * Dónde aparece cada palabra de la búsqueda, con un peso. La identidad (agente y nombre visible, que fija el
 * administrador) pesa más que el nombre de sesión, y este más que el texto libre (descripción, etiquetas, estado):
 * ese texto lo escribe cada sesión, así que una sesión ajena no puede «ganar» una búsqueda solo copiando palabras.
 */
const FIELD_WEIGHT = { agent: 6, session: 3, tags: 2, text: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

function fieldsOf(s: SessionFull): Record<Field, string> {
  return {
    agent: norm(`${s.agent_id} ${s.display_name}`),
    session: norm(s.name),
    tags: norm(parseJson<string[]>(s.tags, []).join(' ')),
    text: norm(`${s.description} ${s.status_text} ${s.cwd ?? ''} ${s.harness ?? ''}`),
  };
}

function matchToken(f: Record<Field, string>, token: string): Field | null {
  for (const k of ['agent', 'session', 'tags', 'text'] as const) if (f[k].includes(token)) return k;
  return null;
}

export interface ListPeersArgs {
  query?: string;
  agent?: string;
  presence?: Presence;
  limit?: number;
}

/** `list_peers`: sesiones visibles; con `query` busca por nombre, persona, descripción y etiquetas. */
export function listPeers(ctx: Ctx, args: ListPeersArgs) {
  const { hub, now } = ctx;
  let rows = all<SessionFull>(hub.db, `${SESSIONS_FULL} ORDER BY s.agent_id, s.name`);
  if (args.agent) rows = rows.filter((r) => r.agent_id === norm(args.agent!) || norm(r.display_name) === norm(args.agent!));
  let match: 'all' | 'partial' | undefined;
  const tokens = args.query ? norm(args.query).split(/[\s,;:/]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t)) : [];
  const info = new Map<string, { score: number; matchedOn: Field[]; identity: boolean }>();
  if (tokens.length) {
    for (const r of rows) {
      const f = fieldsOf(r);
      const hits = tokens.map((t) => matchToken(f, t));
      const matched = hits.filter((h): h is Field => h !== null);
      info.set(r.id, {
        score: matched.reduce((n, h) => n + FIELD_WEIGHT[h], 0),
        matchedOn: [...new Set(matched)],
        // identityMatch: al menos una palabra coincide con la identidad que fijó el ADMINISTRADOR (agente / nombre visible).
        // El nombre de sesión y el texto libre los elige cada sesión, así que por sí solos no prueban quién es.
        identity: hits.includes('agent'),
      });
    }
    const strict = rows.filter((r) => tokens.every((t) => matchToken(fieldsOf(r), t) !== null));
    if (strict.length) {
      rows = strict;
      match = 'all';
    } else {
      rows = rows.filter((r) => info.get(r.id)!.score > 0);
      match = 'partial';
    }
    rows.sort((a, b) => info.get(b.id)!.score - info.get(a.id)!.score);
  }
  let views = rows.map((r) => ({
    ...sessionView(hub, r, ctx.session.id, now),
    ...(info.has(r.id) ? { matchedOn: info.get(r.id)!.matchedOn, identityMatch: info.get(r.id)!.identity } : {}),
  }));
  if (args.presence) views = views.filter((v) => v.presence === args.presence);
  if (!tokens.length) {
    const order: Record<string, number> = { online: 0, recent: 1, away: 2 };
    views.sort((a, b) => order[a.presence]! - order[b.presence]! || a.id.localeCompare(b.id));
  }
  const limit = clamp(args.limit ?? 100, 1, 500);
  return { scopeId: hub.cfg.scope, ...(match ? { match } : {}), count: Math.min(views.length, limit), peers: views.slice(0, limit) };
}

const candidateView = (hub: Hub, s: SessionFull, now: number) => ({
  id: labelOf(s),
  description: s.description,
  presence: hub.presence(s.id, s.last_seen_at, now),
});

/**
 * Resuelve un destinatario a una o varias sesiones. Formas: `ses_<id>`, `agente/sesion`, `agente/*` (todas las
 * sesiones del agente) o `agente` (solo si tiene UNA sesión; con varias falla y enseña las candidatas).
 */
export function resolvePeer(ctx: Ctx, refRaw: string): SessionFull[] {
  const { hub, now } = ctx;
  const ref = refRaw.trim();
  if (/^ses_[0-9a-f]{24}$/.test(ref)) {
    const s = one<SessionFull>(hub.db, `${SESSIONS_FULL} AND s.id = ?`, ref);
    if (!s) throw new ToolError('unknown_peer', `No existe la sesión ${ref}.`, undefined, 404);
    return [s];
  }
  const slash = ref.indexOf('/');
  const agentPart = norm(slash === -1 ? ref : ref.slice(0, slash)).trim();
  const sessionPart = slash === -1 ? undefined : ref.slice(slash + 1).trim().toLowerCase();
  if (!agentPart) throw new ToolError('bad_request', 'Falta el destinatario.');

  let agentId: string | undefined = one<{ id: string }>(hub.db, 'SELECT id FROM agents WHERE id = ? AND disabled_at IS NULL', agentPart)?.id;
  if (!agentId) {
    // Compatibilidad: «o nombre visible único y exacto».
    const byName = all<{ id: string; display_name: string }>(hub.db, 'SELECT id, display_name FROM agents WHERE disabled_at IS NULL').filter(
      (a) => norm(a.display_name) === agentPart,
    );
    if (byName.length === 1) agentId = byName[0]!.id;
  }
  if (!agentId) throw new ToolError('unknown_peer', `No existe el agente «${agentPart}». Usa list_peers para ver los disponibles.`, undefined, 404);

  const sessions = all<SessionFull>(hub.db, `${SESSIONS_FULL} AND s.agent_id = ? ORDER BY s.name`, agentId);
  if (!sessions.length) throw new ToolError('unknown_peer', `El agente «${agentId}» aún no tiene sesiones conectadas.`, undefined, 404);

  if (sessionPart === '*') return sessions;
  if (sessionPart !== undefined) {
    const s = sessions.find((x) => x.name === sessionPart);
    if (!s) {
      throw new ToolError('unknown_peer', `«${agentId}» no tiene una sesión llamada «${sessionPart}».`, {
        candidates: sessions.map((x) => candidateView(hub, x, now)),
      }, 404);
    }
    return [s];
  }
  if (sessions.length === 1) return [sessions[0]!];
  throw new ToolError(
    'ambiguous_peer',
    `«${agentId}» tiene ${sessions.length} sesiones; elige una con «${agentId}/<sesion>» (o «${agentId}/*» para todas).`,
    { candidates: sessions.map((x) => candidateView(hub, x, now)) },
    409,
  );
}
