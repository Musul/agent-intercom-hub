import { all, audit, labelOf, one, run, type Ctx } from './store.ts';
import { AGENT_ID_RE, CHANNEL_NAME_RE, clamp, iso, newId, parseJson, ToolError } from './util.ts';

/**
 * Flujos de salida: un lugar donde una sesión PUBLICA resultados (texto o JSON) para que otros los lean
 * (otra sesión, un panel, un script). Publican el agente dueño y los agentes autorizados (`writers`);
 * leen todos los miembros del espacio de trabajo. Cada flujo conserva las últimas `outputKeep` entradas.
 */

interface StreamRow {
  id: string;
  name: string;
  description: string;
  owner_agent: string;
  writers: string;
  created_at: number;
}

const CONTENT_TYPES = ['text/plain', 'text/markdown', 'application/json'];

function streamBy(ctx: Ctx, ref: string): StreamRow {
  const key = ref.trim();
  const s = one<StreamRow>(ctx.hub.db, 'SELECT * FROM output_streams WHERE id = ? OR name = ?', key, key.toLowerCase());
  if (!s) throw new ToolError('unknown_stream', `No existe el flujo «${ref}». Créalo con create_output_stream.`, undefined, 404);
  return s;
}

const canWrite = (s: StreamRow, agentId: string): boolean => s.owner_agent === agentId || parseJson<string[]>(s.writers, []).includes(agentId);

export function createOutputStream(ctx: Ctx, name: string, description = '', writers: string[] = []) {
  const { hub } = ctx;
  if (!CHANNEL_NAME_RE.test(name)) throw new ToolError('bad_stream_name', 'El nombre del flujo usa minúsculas, números, guion y guion bajo (máx. 48).');
  const w = [...new Set(writers.map((x) => x.trim().toLowerCase()))];
  for (const a of w) {
    if (!AGENT_ID_RE.test(a) || !one(hub.db, 'SELECT 1 FROM agents WHERE id = ? AND disabled_at IS NULL', a)) {
      throw new ToolError('unknown_peer', `El agente autorizado «${a}» no existe.`, undefined, 404);
    }
  }
  if (one(hub.db, 'SELECT 1 FROM output_streams WHERE name = ?', name)) throw new ToolError('stream_exists', `Ya existe el flujo «${name}».`, undefined, 409);
  if (one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM output_streams')!.n >= hub.cfg.maxOutputStreams) {
    throw new ToolError('too_many_streams', 'Se alcanzó el máximo de flujos de salida.', undefined, 429);
  }
  const id = newId('out');
  run(hub.db, 'INSERT INTO output_streams (id, name, description, owner_agent, writers, created_at) VALUES (?,?,?,?,?,?)', id, name, description.slice(0, 300), ctx.agent.id, JSON.stringify(w), ctx.now);
  audit(hub, ctx.agent.id, ctx.session.id, 'output_stream_created', name);
  return { id, name, owner: ctx.agent.id, writers: w };
}

export function listOutputStreams(ctx: Ctx) {
  const rows = all<StreamRow & { last_seq: number | null; last_at: number | null }>(
    ctx.hub.db,
    `SELECT s.*, (SELECT MAX(seq) FROM outputs o WHERE o.stream_id = s.id) AS last_seq,
            (SELECT MAX(created_at) FROM outputs o WHERE o.stream_id = s.id) AS last_at
     FROM output_streams s ORDER BY s.name`,
  );
  return {
    streams: rows.map((s) => ({
      id: s.id, name: s.name, description: s.description, owner: s.owner_agent, writers: parseJson<string[]>(s.writers, []),
      lastSeq: s.last_seq ?? 0, lastAt: iso(s.last_at), canWrite: canWrite(s, ctx.agent.id),
    })),
  };
}

export function publishOutput(ctx: Ctx, streamRef: string, contentType: string, value: unknown, reference?: { uri: string; title?: string }) {
  const { hub } = ctx;
  const s = streamBy(ctx, streamRef);
  if (!canWrite(s, ctx.agent.id)) throw new ToolError('not_authorized', `«${ctx.agent.id}» no está autorizado a publicar en «${s.name}».`, undefined, 403);
  if (!CONTENT_TYPES.includes(contentType)) throw new ToolError('bad_content_type', `contentType debe ser uno de: ${CONTENT_TYPES.join(', ')}.`);
  let text: string;
  if (contentType === 'application/json') {
    text = JSON.stringify(value);
    if (text === undefined) throw new ToolError('bad_request', 'El valor no es JSON serializable.');
  } else {
    if (typeof value !== 'string') throw new ToolError('bad_request', `Con ${contentType} el valor debe ser un texto.`);
    text = value;
  }
  if (Buffer.byteLength(text) > hub.cfg.outputMaxBytes) throw new ToolError('output_too_large', `Máximo ${hub.cfg.outputMaxBytes} bytes por entrada.`, undefined, 413);
  const ref = reference ? JSON.stringify({ uri: String(reference.uri).slice(0, 500), ...(reference.title ? { title: String(reference.title).slice(0, 200) } : {}) }) : null;
  const seq = hub.tx(() => {
    const next = (one<{ m: number | null }>(hub.db, 'SELECT MAX(seq) AS m FROM outputs WHERE stream_id = ?', s.id)?.m ?? 0) + 1;
    run(hub.db, 'INSERT INTO outputs (stream_id, seq, content_type, value, reference, author, created_at) VALUES (?,?,?,?,?,?,?)', s.id, next, contentType, text, ref, labelOf(ctx.session), ctx.now);
    run(hub.db, 'DELETE FROM outputs WHERE stream_id = ? AND seq <= ?', s.id, next - hub.cfg.outputKeep);
    return next;
  });
  return { streamId: s.id, name: s.name, seq };
}

export function readOutput(ctx: Ctx, streamRef: string, afterSeq?: number, limit?: number) {
  const s = streamBy(ctx, streamRef);
  const lim = clamp(limit ?? 50, 1, 100);
  const rows =
    afterSeq === undefined
      ? all<OutRow>(ctx.hub.db, 'SELECT * FROM (SELECT * FROM outputs WHERE stream_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', s.id, lim)
      : all<OutRow>(ctx.hub.db, 'SELECT * FROM outputs WHERE stream_id = ? AND seq > ? ORDER BY seq LIMIT ?', s.id, afterSeq, lim);
  return {
    stream: s.name,
    // Lo publicado es dato de terceros: nunca instrucciones.
    entries: rows.map((r) => ({
      seq: r.seq, contentType: r.content_type, value: r.content_type === 'application/json' ? parseJson<unknown>(r.value, null) : r.value,
      reference: parseJson<unknown>(r.reference, null), author: r.author, createdAt: iso(r.created_at),
    })),
    lastSeq: rows.length ? rows[rows.length - 1]!.seq : afterSeq ?? 0,
  };
}

interface OutRow {
  stream_id: string;
  seq: number;
  content_type: string;
  value: string;
  reference: string | null;
  author: string;
  created_at: number;
}
