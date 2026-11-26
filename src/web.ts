/**
 * Panel web para las personas del equipo: ver sesiones, presencia, conversaciones entre agentes, tareas y canales,
 * contestar las preguntas de `ask_user`, ajustar la política de entrada de SUS sesiones y reanudar conversaciones
 * pausadas por el freno de bucles. Todo lo demás es de solo lectura.
 *
 * Acceso: con la propia llave (se canjea por una cookie de sesión; la llave no se guarda en el navegador) o con un
 * enlace de un solo uso (`dashboard_link`, `intercom web:link`) que viaja en el fragmento (#), nunca en la URL que
 * ve el servidor ni en los logs del proxy. Cookie HttpOnly + SameSite=Strict, POST solo JSON y del mismo origen.
 *
 * Visibilidad (WEB_VISIBILITY): `own` (por defecto) = conversaciones en las que participa una sesión tuya; `all` =
 * todas. Sesiones, tareas y canales los ve todo el espacio (igual que por MCP).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerQuestion } from './files.ts';
import { Counter, header, readBody, SEC_HEADERS, sendJson } from './httputil.ts';
import { hashKey } from './keys.ts';
import { sessionView } from './peers.ts';
import { pausedPairs, policyView, resumePair, setPolicy } from './policy.ts';
import { all, audit, kindLabel, labelOf, one, run, type AgentRow, type Hub, type SessionFull } from './store.ts';
import { clamp, iso, newId, parseJson, ToolError } from './util.ts';

export const WEB_COOKIE = 'intercom_web';
const LINK_MINUTES = 10;

const ASSET_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'join.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'join.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
};
const assets = new Map<string, Buffer>();
function asset(name: string): Buffer {
  let b = assets.get(name);
  if (!b) assets.set(name, (b = readFileSync(new URL(`./web/${name}`, import.meta.url))));
  return b;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendAsset(res: ServerResponse, name: string): void {
  const data = asset(name);
  res.writeHead(200, {
    'Content-Type': ASSET_TYPES[name]!,
    'Content-Length': data.length,
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...SEC_HEADERS,
  });
  res.end(data);
}

/** Origen público para los enlaces: PUBLIC_URL o el que vio el cliente (Host + esquema del proxy de confianza). */
export function originOf(hub: Hub, req?: IncomingMessage): string {
  if (hub.cfg.publicUrl) return hub.cfg.publicUrl;
  if (!req) return '';
  const proto = hub.cfg.trustProxy && header(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http';
  return `${proto}://${header(req, 'host') ?? 'localhost'}`;
}

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Enlace de un solo uso al panel (10 min). El token va en el fragmento: no llega al servidor al abrir la página. */
export function createWebLink(hub: Hub, agentId: string, origin: string): { url: string; expiresAt: string | null } {
  const token = `iwl_${randomBytes(24).toString('base64url')}`;
  const now = Date.now();
  run(hub.db, 'DELETE FROM web_links WHERE expires_at < ? OR used_at IS NOT NULL', now - 86_400_000);
  run(hub.db, 'INSERT INTO web_links (token_hash, agent_id, created_at, expires_at) VALUES (?,?,?,?)', tokenHash(token), agentId, now, now + LINK_MINUTES * 60_000);
  audit(hub, agentId, null, 'web_link_created', '');
  return { url: `${origin}/web/#link=${token}`, expiresAt: iso(now + LINK_MINUTES * 60_000) };
}

function startWebSession(hub: Hub, res: ServerResponse, req: IncomingMessage, agent: AgentRow, how: string): void {
  const token = `iws_${randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  const ttl = hub.cfg.webSessionHours * 3_600_000;
  run(hub.db, 'DELETE FROM web_sessions WHERE expires_at < ?', now);
  run(hub.db, 'INSERT INTO web_sessions (id, agent_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?)', newId('web'), agent.id, tokenHash(token), now, now + ttl, now);
  audit(hub, agent.id, null, 'web_login', how);
  const secure = hub.cfg.publicUrl.startsWith('https://') || (hub.cfg.trustProxy && header(req, 'x-forwarded-proto') === 'https');
  const cookie = `${WEB_COOKIE}=${token}; Path=/web; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${secure ? '; Secure' : ''}`;
  sendJson(res, 200, { ok: true, me: { id: agent.id, displayName: agent.display_name } }, { 'Set-Cookie': cookie });
}

function cookieToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === WEB_COOKIE) return v.join('=') || null;
  }
  return null;
}

function webAgent(hub: Hub, req: IncomingMessage): AgentRow | null {
  const t = cookieToken(req);
  if (!t) return null;
  const row = one<AgentRow & { ws_id: string; last_seen_at_ws: number }>(
    hub.db,
    `SELECT a.*, w.id AS ws_id, w.last_seen_at AS last_seen_at_ws FROM web_sessions w JOIN agents a ON a.id = w.agent_id
      WHERE w.token_hash = ? AND w.expires_at > ? AND a.disabled_at IS NULL`,
    tokenHash(t), Date.now(),
  );
  if (!row) return null;
  if (Date.now() - row.last_seen_at_ws > 60_000) run(hub.db, 'UPDATE web_sessions SET last_seen_at = ? WHERE id = ?', Date.now(), row.ws_id);
  const { ws_id: _w, last_seen_at_ws: _l, ...agent } = row;
  return agent;
}

const SESSIONS_FULL = `SELECT s.*, a.display_name AS display_name, a.kind AS agent_kind FROM sessions s JOIN agents a ON a.id = s.agent_id
  WHERE s.retired_at IS NULL AND a.disabled_at IS NULL`;

interface MsgLite {
  id: string;
  kind: string;
  from_session: string | null;
  from_label: string;
  to_session: string;
  mode: string;
  body: string;
  response_to: string | null;
  state: string;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  wake: number;
  held_reason: string | null;
}

const msgOut = (m: MsgLite, labels: Map<string, string>) => ({
  id: m.id,
  kind: m.kind,
  kindLabel: kindLabel(m.kind, m.mode),
  from: m.from_label,
  to: labels.get(m.to_session) ?? m.to_session,
  mode: m.mode,
  body: m.body,
  responseTo: m.response_to,
  state: m.state,
  wake: m.wake === 1,
  heldReason: m.held_reason,
  createdAt: iso(m.created_at),
  deliveredAt: iso(m.delivered_at),
  acknowledgedAt: iso(m.acked_at),
});

/** Todo lo que el panel muestra de un vistazo (se refresca cada pocos segundos). */
function state(hub: Hub, me: AgentRow) {
  const now = Date.now();
  const rows = all<SessionFull>(hub.db, `${SESSIONS_FULL} ORDER BY s.agent_id, s.name`);
  const agentOf = new Map(rows.map((r) => [r.id, r.agent_id]));
  const labels = new Map(rows.map((r) => [r.id, labelOf(r)]));
  const visible = (x: string, y: string) => hub.cfg.webVisibility === 'all' || agentOf.get(x) === me.id || agentOf.get(y) === me.id;
  const sessions = rows.map((r) => {
    const v = sessionView(hub, r, null, now);
    const pending = one<{ n: number }>(hub.db, `SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND state IN ('queued','delivered')`, r.id)!.n;
    return { ...v, mine: r.agent_id === me.id, pending, ...(r.agent_id === me.id ? { inboundPolicy: policyView(hub, r, now) } : { inbound: r.inbound }) };
  });
  const pairs = new Map<string, { a: string; b: string; messages: number; held: number; lastAt: number }>();
  for (const p of all<{ f: string; t: string; n: number; h: number; last: number }>(
    hub.db,
    `SELECT from_session AS f, to_session AS t, COUNT(*) AS n, SUM(wake = 0) AS h, MAX(created_at) AS last
       FROM messages WHERE kind = 'direct' AND from_session IS NOT NULL GROUP BY from_session, to_session`,
  )) {
    if (!labels.has(p.f) || !labels.has(p.t) || !visible(p.f, p.t)) continue;
    const [a, b] = p.f < p.t ? [p.f, p.t] : [p.t, p.f];
    const k = `${a}|${b}`;
    const cur = pairs.get(k) ?? { a, b, messages: 0, held: 0, lastAt: 0 };
    cur.messages += p.n;
    cur.held += p.h;
    cur.lastAt = Math.max(cur.lastAt, p.last);
    pairs.set(k, cur);
  }
  const paused = pausedPairs(hub).filter((p) => visible(p.sessionA, p.sessionB));
  const pausedKeys = new Set(paused.map((p) => (p.sessionA < p.sessionB ? `${p.sessionA}|${p.sessionB}` : `${p.sessionB}|${p.sessionA}`)));
  const conversations = [...pairs.entries()]
    .sort((x, y) => y[1].lastAt - x[1].lastAt)
    .slice(0, 200)
    .map(([k, c]) => ({ a: { sessionId: c.a, label: labels.get(c.a) }, b: { sessionId: c.b, label: labels.get(c.b) }, messages: c.messages, held: c.held, lastAt: iso(c.lastAt), paused: pausedKeys.has(k) }));
  const tasks = all<{ id: string; title: string; description: string; state: string; deps: string; tags: string; created_by: string; claimed_by: string | null; result: string | null; created_at: number; completed_at: number | null; progress: number }>(
    hub.db,
    `SELECT t.*, (SELECT COUNT(*) FROM task_progress p WHERE p.task_id = t.id) AS progress FROM tasks t ORDER BY t.created_at DESC LIMIT 300`,
  ).map((t) => ({
    id: t.id, title: t.title, description: t.description, state: t.state, tags: parseJson<string[]>(t.tags, []), dependencies: parseJson<string[]>(t.deps, []),
    createdBy: t.created_by, claimedBy: t.claimed_by, result: t.result, progress: t.progress, createdAt: iso(t.created_at), completedAt: iso(t.completed_at),
  }));
  const questions = all<{ id: string; session_id: string; asked_by: string; question: string; options: string | null; state: string; answer: string | null; answered_by: string | null; created_at: number; answered_at: number | null; person: string | null }>(
    hub.db,
    `SELECT q.* FROM questions q JOIN sessions s ON s.id = q.session_id
      WHERE (q.person = ? OR (q.person IS NULL AND s.agent_id = ?)) AND (q.state = 'open' OR q.answered_at > ?)
      ORDER BY q.state = 'open' DESC, q.created_at DESC LIMIT 100`,
    me.id, me.id, now - 7 * 86_400_000,
  ).map((q) => ({
    id: q.id, askedBy: q.asked_by, question: q.question, options: parseJson<string[]>(q.options, []), state: q.state, answer: q.answer, answeredBy: q.answered_by,
    createdAt: iso(q.created_at), answeredAt: iso(q.answered_at),
  }));
  const channels = all<{ id: string; name: string; description: string; posts: number; last: number | null }>(
    hub.db,
    `SELECT c.id, c.name, c.description, (SELECT COUNT(*) FROM channel_posts p WHERE p.channel_id = c.id) AS posts,
            (SELECT MAX(created_at) FROM channel_posts p WHERE p.channel_id = c.id) AS last
       FROM channels c ORDER BY last DESC NULLS LAST, c.name`,
  ).map((c) => ({ id: c.id, name: c.name, description: c.description, posts: c.posts, lastPostAt: iso(c.last) }));
  return {
    me: { id: me.id, displayName: me.display_name },
    scope: hub.cfg.scope,
    visibility: hub.cfg.webVisibility,
    now: iso(now),
    sessions,
    conversations,
    paused,
    tasks,
    questions,
    channels,
  };
}

function conversation(hub: Hub, me: AgentRow, a: string, b: string) {
  const sa = one<SessionFull>(hub.db, `${SESSIONS_FULL} AND s.id = ?`, a);
  const sb = one<SessionFull>(hub.db, `${SESSIONS_FULL} AND s.id = ?`, b);
  if (!sa || !sb) throw new ToolError('unknown_peer', 'No existe esa conversación.', undefined, 404);
  if (hub.cfg.webVisibility !== 'all' && sa.agent_id !== me.id && sb.agent_id !== me.id) throw new ToolError('forbidden', 'No participas en esa conversación.', undefined, 403);
  const labels = new Map([[sa.id, labelOf(sa)], [sb.id, labelOf(sb)]]);
  const msgs = all<MsgLite>(
    hub.db,
    `SELECT * FROM messages WHERE kind = 'direct' AND ((from_session = ? AND to_session = ?) OR (from_session = ? AND to_session = ?))
      ORDER BY created_at DESC, rowid DESC LIMIT 300`,
    a, b, b, a,
  ).reverse();
  return { a: labels.get(a), b: labels.get(b), messages: msgs.map((m) => msgOut(m, labels)) };
}

function inbox(hub: Hub, me: AgentRow, sessionId: string) {
  const s = one<SessionFull>(hub.db, `${SESSIONS_FULL} AND s.id = ?`, sessionId);
  if (!s) throw new ToolError('unknown_peer', 'No existe esa sesión.', undefined, 404);
  if (s.agent_id !== me.id && hub.cfg.webVisibility !== 'all') throw new ToolError('forbidden', 'Solo puedes ver el buzón de tus sesiones.', undefined, 403);
  const labels = new Map([[s.id, labelOf(s)]]);
  const msgs = all<MsgLite>(hub.db, 'SELECT * FROM messages WHERE to_session = ? ORDER BY created_at DESC, rowid DESC LIMIT 100', s.id);
  return { session: labelOf(s), messages: msgs.map((m) => msgOut(m, labels)) };
}

function channel(hub: Hub, id: string) {
  const c = one<{ id: string; name: string; description: string }>(hub.db, 'SELECT id, name, description FROM channels WHERE id = ? OR name = ?', id, id);
  if (!c) throw new ToolError('unknown_channel', 'No existe ese canal.', undefined, 404);
  const posts = all<{ id: string; thread_id: string | null; author_label: string; body: string; created_at: number }>(
    hub.db, 'SELECT id, thread_id, author_label, body, created_at FROM channel_posts WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200', c.id,
  ).reverse();
  return { ...c, posts: posts.map((p) => ({ id: p.id, threadId: p.thread_id, author: p.author_label, body: p.body, createdAt: iso(p.created_at) })) };
}

function task(hub: Hub, id: string) {
  const t = one<{ id: string; title: string; description: string; state: string; result: string | null }>(hub.db, 'SELECT id, title, description, state, result FROM tasks WHERE id = ?', id);
  if (!t) throw new ToolError('unknown_task', 'No existe esa tarea.', undefined, 404);
  const progress = all<{ id: string; author: string; note: string; created_at: number }>(hub.db, 'SELECT * FROM task_progress WHERE task_id = ? ORDER BY created_at, rowid LIMIT 500', id);
  return { ...t, progress: progress.map((p) => ({ id: p.id, author: p.author, note: p.note, createdAt: iso(p.created_at) })) };
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, 64 * 1024)).toString('utf8');
  try {
    const v = raw.trim() ? JSON.parse(raw) : {};
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* abajo */
  }
  throw new ToolError('invalid_json', 'JSON inválido.');
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * /web/* y /join. `fails` es el freno de llaves falsas por IP (el mismo de la API).
 */
export async function handleWeb(hub: Hub, req: IncomingMessage, res: ServerResponse, url: URL, ip: string, fails: Counter): Promise<void> {
  const path = url.pathname;
  if (path === '/join' || path === '/join/') return sendAsset(res, 'join.html');
  if (path === '/join/join.js') return sendAsset(res, 'join.js');
  if (path === '/web') {
    res.writeHead(308, { Location: '/web/', ...SEC_HEADERS });
    return void res.end();
  }
  if (path === '/web/') return sendAsset(res, 'index.html');
  if (path === '/web/app.js') return sendAsset(res, 'app.js');
  if (path === '/web/app.css') return sendAsset(res, 'app.css');
  if (!path.startsWith('/web/api/')) return sendJson(res, 404, { error: 'not_found' });

  const route = path.slice('/web/api/'.length);
  if (req.method === 'POST') {
    // Anti-CSRF: solo JSON y, si el navegador manda Origin, del mismo sitio.
    if (!(header(req, 'content-type') ?? '').startsWith('application/json')) return sendJson(res, 415, { ok: false, error: { code: 'json_only', message: 'Solo JSON.' } });
    const origin = header(req, 'origin');
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* inválido */
      }
      if (host !== header(req, 'host')) return sendJson(res, 403, { ok: false, error: { code: 'origin_not_allowed', message: 'Origen no permitido.' } });
    }
  } else if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });

  try {
    // Entrar: con la llave personal o con un enlace de un solo uso.
    if (route === 'login' || route === 'link') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      const wait = fails.over(ip, hub.cfg.authFailPerMinute);
      if (wait) return sendJson(res, 429, { ok: false, error: { code: 'too_many_auth_failures', message: 'Demasiados intentos; espera un minuto.' } }, { 'Retry-After': String(wait) });
      const body = await jsonBody(req);
      let agent: AgentRow | undefined;
      if (route === 'login') {
        const key = str(body.key, 200)?.trim() ?? '';
        agent = key
          ? one<AgentRow>(hub.db, `SELECT a.* FROM api_keys k JOIN agents a ON a.id = k.agent_id WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.disabled_at IS NULL`, hashKey(key))
          : undefined;
      } else {
        const token = str(body.token, 200)?.trim() ?? '';
        const now = Date.now();
        const link = token ? one<{ agent_id: string }>(hub.db, 'SELECT agent_id FROM web_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', tokenHash(token), now) : undefined;
        if (link) {
          run(hub.db, 'UPDATE web_links SET used_at = ? WHERE token_hash = ?', now, tokenHash(token));
          agent = one<AgentRow>(hub.db, 'SELECT * FROM agents WHERE id = ? AND disabled_at IS NULL', link.agent_id);
        }
      }
      if (!agent) {
        fails.hit(ip, hub.cfg.authFailPerMinute);
        return sendJson(res, 401, { ok: false, error: { code: route === 'login' ? 'invalid_api_key' : 'invalid_link', message: route === 'login' ? 'Llave no válida.' : 'Enlace no válido, usado o caducado: pide otro.' } });
      }
      return startWebSession(hub, res, req, agent, route);
    }

    const me = webAgent(hub, req);
    if (!me) return sendJson(res, 401, { ok: false, error: { code: 'login_required', message: 'Inicia sesión.' } });

    if (route === 'logout' && req.method === 'POST') {
      const t = cookieToken(req);
      if (t) run(hub.db, 'DELETE FROM web_sessions WHERE token_hash = ?', tokenHash(t));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${WEB_COOKIE}=; Path=/web; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (req.method === 'GET') {
      const q = (k: string) => url.searchParams.get(k) ?? '';
      if (route === 'state') return sendJson(res, 200, { ok: true, result: state(hub, me) });
      if (route === 'conversation') return sendJson(res, 200, { ok: true, result: conversation(hub, me, q('a'), q('b')) });
      if (route === 'inbox') return sendJson(res, 200, { ok: true, result: inbox(hub, me, q('session')) });
      if (route === 'channel') return sendJson(res, 200, { ok: true, result: channel(hub, q('id')) });
      if (route === 'task') return sendJson(res, 200, { ok: true, result: task(hub, q('id')) });
      return sendJson(res, 404, { error: 'not_found' });
    }

    const body = await jsonBody(req);
    if (route === 'answer') {
      const id = str(body.id, 60) ?? '';
      const answer = (str(body.answer, 4000) ?? '').trim();
      if (!answer) throw new ToolError('bad_request', 'Escribe una respuesta.');
      const qrow = one<{ person: string | null; agent_id: string }>(hub.db, 'SELECT q.person, s.agent_id FROM questions q JOIN sessions s ON s.id = q.session_id WHERE q.id = ?', id);
      if (!qrow) throw new ToolError('unknown_question', 'No existe esa pregunta.', undefined, 404);
      if ((qrow.person ?? qrow.agent_id) !== me.id) throw new ToolError('forbidden', 'Esa pregunta es para otra persona.', undefined, 403);
      return sendJson(res, 200, { ok: true, result: answerQuestion(hub, id, answer, me.id) });
    }
    if (route === 'policy') {
      const sid = str(body.sessionId, 60) ?? '';
      const s = one<{ agent_id: string }>(hub.db, 'SELECT agent_id FROM sessions WHERE id = ? AND retired_at IS NULL', sid);
      if (!s) throw new ToolError('unknown_peer', 'No existe esa sesión.', undefined, 404);
      if (s.agent_id !== me.id) throw new ToolError('forbidden', 'Solo puedes cambiar la política de tus sesiones.', undefined, 403);
      const wph = body.wakePerHour;
      setPolicy(
        hub, sid,
        {
          inbound: str(body.inbound, 10),
          allowFrom: Array.isArray(body.allowFrom) ? body.allowFrom.filter((x): x is string => typeof x === 'string') : undefined,
          wakePerHour: wph === null ? null : typeof wph === 'number' ? wph : undefined,
        },
        `web:${me.id}`,
      );
      const row = one<SessionFull>(hub.db, `${SESSIONS_FULL} AND s.id = ?`, sid)!;
      return sendJson(res, 200, { ok: true, result: policyView(hub, row) });
    }
    if (route === 'resume') {
      const a = str(body.a, 60) ?? '';
      const b = str(body.b, 60) ?? '';
      const owners = all<{ agent_id: string }>(hub.db, 'SELECT agent_id FROM sessions WHERE id IN (?, ?)', a, b).map((r) => r.agent_id);
      if (owners.length !== 2) throw new ToolError('unknown_peer', 'No existe esa conversación.', undefined, 404);
      if (hub.cfg.webVisibility !== 'all' && !owners.includes(me.id)) throw new ToolError('forbidden', 'No participas en esa conversación.', undefined, 403);
      const ok = resumePair(hub, a, b);
      audit(hub, me.id, null, 'loop_resumed', `${a} <-> ${b} (web)`);
      return sendJson(res, 200, { ok: true, result: { resumed: ok } });
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof ToolError) return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
    throw e;
  }
}

/** Para la CLI `feed`: los últimos mensajes entre sesiones (de todo el espacio), del más viejo al más nuevo. */
export function feed(hub: Hub, limit: number, afterRowid = 0) {
  const labels = new Map(all<{ id: string; agent_id: string; name: string }>(hub.db, 'SELECT id, agent_id, name FROM sessions').map((s) => [s.id, labelOf(s)]));
  const rows = all<MsgLite & { rowid: number }>(
    hub.db,
    `SELECT rowid, * FROM messages WHERE rowid > ? ORDER BY rowid DESC LIMIT ?`,
    afterRowid, clamp(limit, 1, 1000),
  ).reverse();
  return rows.map((m) => ({ rowid: m.rowid, ...msgOut(m, labels) }));
}
