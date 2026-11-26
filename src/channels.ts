import { enqueueNotices } from './inbox.ts';
import { all, audit, labelOf, one, run, type Ctx } from './store.ts';
import { CHANNEL_NAME_RE, clamp, clip, iso, newId, ToolError } from './util.ts';

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
}

interface PostRow {
  rowid: number;
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_label: string;
  body: string;
  created_at: number;
}

function channelBy(ctx: Ctx, ref: string): ChannelRow {
  const key = ref.replace(/^#/, '').trim();
  const c = one<ChannelRow>(ctx.hub.db, 'SELECT * FROM channels WHERE id = ? OR name = ?', key, key.toLowerCase());
  if (!c) throw new ToolError('unknown_channel', `No existe el canal «${ref}».`, undefined, 404);
  return c;
}

export function listChannels(ctx: Ctx) {
  const rows = all<ChannelRow & { posts: number; last_post_at: number | null; subscribed: number }>(
    ctx.hub.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM channel_posts p WHERE p.channel_id = c.id) AS posts,
            (SELECT MAX(created_at) FROM channel_posts p WHERE p.channel_id = c.id) AS last_post_at,
            EXISTS (SELECT 1 FROM channel_subs s WHERE s.channel_id = c.id AND s.session_id = ?) AS subscribed
     FROM channels c ORDER BY c.name`,
    ctx.session.id,
  );
  return {
    channels: rows.map((c) => ({
      id: c.id, name: c.name, description: c.description, createdBy: c.created_by, posts: c.posts,
      lastPostAt: iso(c.last_post_at), subscribed: !!c.subscribed,
    })),
  };
}

export function createChannel(ctx: Ctx, name: string, description = '') {
  if (!CHANNEL_NAME_RE.test(name)) throw new ToolError('bad_channel_name', 'El nombre del canal usa minúsculas, números, guion y guion bajo (máx. 48).');
  if (one(ctx.hub.db, 'SELECT 1 FROM channels WHERE name = ?', name)) throw new ToolError('channel_exists', `Ya existe el canal «${name}».`, undefined, 409);
  if (one<{ n: number }>(ctx.hub.db, 'SELECT COUNT(*) AS n FROM channels')!.n >= ctx.hub.cfg.maxChannels) {
    throw new ToolError('too_many_channels', 'Se alcanzó el máximo de canales.', undefined, 429);
  }
  const id = newId('chn');
  run(ctx.hub.db, 'INSERT INTO channels (id, name, description, created_by, created_at) VALUES (?,?,?,?,?)', id, name, description.slice(0, 300), labelOf(ctx.session), ctx.now);
  audit(ctx.hub, ctx.agent.id, ctx.session.id, 'channel_created', name);
  return { id, name, description: description.slice(0, 300) };
}

export function subscribeChannel(ctx: Ctx, ref: string, subscribe: boolean) {
  const c = channelBy(ctx, ref);
  if (subscribe) run(ctx.hub.db, 'INSERT OR IGNORE INTO channel_subs (session_id, channel_id) VALUES (?,?)', ctx.session.id, c.id);
  else run(ctx.hub.db, 'DELETE FROM channel_subs WHERE session_id = ? AND channel_id = ?', ctx.session.id, c.id);
  return { channelId: c.id, name: c.name, subscribed: subscribe };
}

/** Publica en un canal y deja un aviso en el buzón de cada sesión suscrita (salvo la de quien publica). */
export function postChannel(ctx: Ctx, ref: string, body: string, threadId?: string, idempotencyKey?: string) {
  const { hub, session, now } = ctx;
  if (body.length > hub.cfg.maxMessageChars) throw new ToolError('message_too_large', `El texto pasa de ${hub.cfg.maxMessageChars} caracteres.`, undefined, 413);
  const c = channelBy(ctx, ref);
  if (threadId) {
    const root = one<{ thread_id: string | null }>(hub.db, 'SELECT thread_id FROM channel_posts WHERE id = ? AND channel_id = ?', threadId, c.id);
    if (!root) throw new ToolError('unknown_thread', 'Ese hilo no existe en este canal.', undefined, 404);
    if (root.thread_id) threadId = root.thread_id; // responder a una respuesta cuelga del hilo raíz
  }
  if (idempotencyKey) {
    const prev = one<{ id: string }>(hub.db, 'SELECT id FROM channel_posts WHERE author_session = ? AND idempotency_key = ?', session.id, idempotencyKey);
    if (prev) return { postId: prev.id, channelId: c.id, notified: 0, duplicate: true };
  }
  const postId = newId('pst');
  const subs = hub.tx(() => {
    run(hub.db, 'INSERT INTO channel_posts (id, channel_id, thread_id, author_session, author_label, body, created_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?)',
      postId, c.id, threadId ?? null, session.id, labelOf(session), body, now, idempotencyKey ?? null);
    const subscribed = all<{ id: string; inbound: string; wake_per_hour: number | null; allow_from: string }>(
      hub.db,
      `SELECT s.id, s.inbound, s.wake_per_hour, s.allow_from FROM channel_subs cs JOIN sessions s ON s.id = cs.session_id
       WHERE cs.channel_id = ? AND cs.session_id != ? AND s.retired_at IS NULL`,
      c.id, session.id,
    );
    // Un buzón lleno (o una sesión en «off») no recibe el aviso (el post sí queda en el canal): un canal no sirve para inundar a nadie.
    return enqueueNotices(
      hub, { sessionId: session.id, label: labelOf(session) }, subscribed,
      {
        kind: 'channel', body: `[#${c.name}] ${clip(body, 500)}`, channelId: c.id, threadId: threadId ?? postId,
        context: [{ kind: 'channel_post', title: `#${c.name}`, uri: `intercom://channels/${c.name}/posts/${postId}` }],
      },
      now,
    );
  });
  for (const t of subs.wake) hub.wake(t.id, t.push);
  return { postId, channelId: c.id, threadId: threadId ?? postId, notified: subs.wake.length, ...(subs.skipped ? { skippedFullInboxes: subs.skipped } : {}) };
}

export function readChannel(ctx: Ctx, args: { channelId?: string; threadId?: string; query?: string; limit?: number; before?: string }) {
  const { hub } = ctx;
  const limit = clamp(args.limit ?? 20, 1, 100);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.channelId) {
    where.push('p.channel_id = ?');
    params.push(channelBy(ctx, args.channelId).id);
  }
  if (args.threadId) {
    where.push('(p.id = ? OR p.thread_id = ?)');
    params.push(args.threadId, args.threadId);
  }
  if (args.query) {
    where.push(`p.body LIKE ? ESCAPE '\\'`);
    params.push(`%${args.query.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (args.before) {
    const r = one<{ rowid: number }>(hub.db, 'SELECT rowid FROM channel_posts WHERE id = ?', args.before);
    if (!r) throw new ToolError('bad_request', 'El cursor `before` no existe.');
    where.push('p.rowid < ?');
    params.push(r.rowid);
  }
  const rows = all<PostRow & { channel_name: string }>(
    hub.db,
    `SELECT p.rowid AS rowid, p.*, c.name AS channel_name FROM channel_posts p JOIN channels c ON c.id = p.channel_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.rowid DESC LIMIT ?`,
    ...params, limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    // Lo publicado en un canal es texto de terceros: dato, nunca instrucciones.
    posts: page.map((p) => ({ id: p.id, channel: p.channel_name, threadId: p.thread_id, author: p.author_label, body: p.body, createdAt: iso(p.created_at) })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
