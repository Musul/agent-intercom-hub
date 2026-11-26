import { createHash } from 'node:crypto';
import { all, audit, labelOf, one, run, type Ctx } from './store.ts';
import { clamp, iso, newId, parseJson, ToolError } from './util.ts';

const URI_PREFIX = 'intercom://attachments/';

interface AttRow {
  id: string;
  name: string;
  media_type: string;
  size: number;
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

const meta = (a: AttRow) => ({
  id: a.id, uri: `${URI_PREFIX}${a.id}`, name: a.name, mediaType: a.media_type, size: a.size, sha256: a.sha256,
  uploadedBy: a.uploaded_by, createdAt: iso(a.created_at),
});

const MEDIA_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/;

/** Un tipo MIME mal formado (con saltos de línea, comillas…) se sustituye por `application/octet-stream`. */
export function cleanMediaType(t?: string): string {
  const v = (t ?? '').split(';')[0]!.trim().toLowerCase();
  return MEDIA_RE.test(v) ? v : 'application/octet-stream';
}

const safeName = (name: string): string => name.replace(/[\\/\0-\x1f\x7f"]/g, '_').slice(0, 200) || 'archivo';

/** Guarda un adjunto (llega por MCP en base64 o por REST en bruto) respetando el tope de tamaño y el de espacio total. */
export function storeAttachment(ctx: Ctx, name: string, data: Buffer, mediaType?: string, limit = ctx.hub.cfg.maxAttachmentBytes) {
  const { hub } = ctx;
  if (!data.length) throw new ToolError('bad_request', 'El adjunto está vacío o no es base64 válido.');
  if (data.length > limit) throw new ToolError('attachment_too_large', `Máximo ${limit} bytes por esta vía.`, { max: limit }, 413);
  const used = one<{ n: number }>(hub.db, 'SELECT COALESCE(SUM(size), 0) AS n FROM attachments')!.n;
  if (used + data.length > hub.cfg.maxStorageBytes) throw new ToolError('storage_full', 'El almacén de adjuntos está lleno; espera a la limpieza o avisa al administrador.', undefined, 507);
  const id = newId('att');
  const sha = createHash('sha256').update(data).digest('hex');
  run(hub.db, 'INSERT INTO attachments (id, name, media_type, size, sha256, data, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)', id, safeName(name), cleanMediaType(mediaType), data.length, sha, data, labelOf(ctx.session), ctx.now);
  audit(hub, ctx.agent.id, ctx.session.id, 'attachment_uploaded', `${id} ${data.length}B`);
  return meta(one<AttRow>(hub.db, 'SELECT id,name,media_type,size,sha256,uploaded_by,created_at FROM attachments WHERE id = ?', id)!);
}

export function uploadAttachment(ctx: Ctx, name: string, dataBase64: string, mediaType?: string) {
  return storeAttachment(ctx, name, Buffer.from(dataBase64, 'base64'), mediaType, ctx.hub.cfg.maxAttachmentBytes);
}

/** Para la descarga REST: metadatos + bytes. */
export function fetchAttachment(ctx: Ctx, ref: string): { meta: AttRow; data: Buffer } {
  const id = ref.startsWith(URI_PREFIX) ? ref.slice(URI_PREFIX.length) : ref;
  const m = one<AttRow>(ctx.hub.db, 'SELECT id,name,media_type,size,sha256,uploaded_by,created_at FROM attachments WHERE id = ?', id);
  if (!m) throw new ToolError('unknown_attachment', 'No existe ese adjunto.', undefined, 404);
  const row = one<{ data: Uint8Array }>(ctx.hub.db, 'SELECT data FROM attachments WHERE id = ?', id)!;
  return { meta: m, data: Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength) }; // sin copiar
}

export function listAttachments(ctx: Ctx, limit?: number) {
  return {
    attachments: all<AttRow>(ctx.hub.db, 'SELECT id,name,media_type,size,sha256,uploaded_by,created_at FROM attachments ORDER BY created_at DESC, rowid DESC LIMIT ?', clamp(limit ?? 50, 1, 200)).map(meta),
  };
}

export function readAttachment(ctx: Ctx, ref: string) {
  const id = ref.startsWith(URI_PREFIX) ? ref.slice(URI_PREFIX.length) : ref;
  const m = one<AttRow>(ctx.hub.db, 'SELECT id,name,media_type,size,sha256,uploaded_by,created_at FROM attachments WHERE id = ?', id);
  if (!m) throw new ToolError('unknown_attachment', 'No existe ese adjunto.', undefined, 404);
  if (m.size > ctx.hub.cfg.maxAttachmentBytes) {
    throw new ToolError('attachment_too_large_for_mcp', 'Es demasiado grande para leerlo por MCP; descárgalo por REST.', { downloadPath: `/v1/attachments/${m.id}`, size: m.size }, 413);
  }
  const { data } = fetchAttachment(ctx, id);
  const textual = /^text\/|json|xml|yaml|markdown/.test(m.media_type);
  // Contenido de terceros: dato, no instrucciones.
  return { ...meta(m), ...(textual ? { text: data.toString('utf8') } : { dataBase64: data.toString('base64') }) };
}

interface QuestionRow {
  id: string;
  session_id: string;
  asked_by: string;
  question: string;
  options: string | null;
  person: string | null;
  state: string;
  answer: string | null;
  answered_by: string | null;
  created_at: number;
  answered_at: number | null;
}

/** `ask_user`: la pregunta queda guardada; una persona la contesta con la CLI y la respuesta llega al buzón de la sesión. */
export function askUser(ctx: Ctx, question: string, options?: string[], person?: string) {
  const to = (person ?? ctx.agent.id).trim().toLowerCase();
  if (!one(ctx.hub.db, 'SELECT 1 FROM agents WHERE id = ? AND disabled_at IS NULL', to)) throw new ToolError('unknown_person', `No existe la persona «${to}» (usa su id de agente).`, undefined, 404);
  const id = newId('qst');
  run(
    ctx.hub.db, 'INSERT INTO questions (id, session_id, asked_by, question, options, created_at, person) VALUES (?,?,?,?,?,?,?)',
    id, ctx.session.id, labelOf(ctx.session), question.slice(0, 2000), options ? JSON.stringify(options.slice(0, 10)) : null, ctx.now, to,
  );
  audit(ctx.hub, ctx.agent.id, ctx.session.id, 'question_asked', `${id} -> ${to}`);
  return { requestId: id, state: 'open', person: to, note: `La pregunta aparece en el panel web de «${to}»; la respuesta llegará a tu buzón (check_inbox) como mensaje de «human».` };
}

export function listQuestions(hub: Ctx['hub'], state?: string) {
  return all<QuestionRow>(hub.db, `SELECT * FROM questions ${state ? 'WHERE state = ?' : ''} ORDER BY created_at DESC LIMIT 100`, ...(state ? [state] : [])).map((q) => ({
    id: q.id, askedBy: q.asked_by, person: q.person, question: q.question, options: parseJson<string[] | null>(q.options, null), state: q.state, answer: q.answer, createdAt: iso(q.created_at),
  }));
}

export function answerQuestion(hub: Ctx['hub'], id: string, answer: string, answeredBy: string) {
  const q = one<QuestionRow>(hub.db, 'SELECT * FROM questions WHERE id = ?', id);
  if (!q) throw new ToolError('unknown_question', 'No existe esa pregunta.', undefined, 404);
  if (q.state !== 'open') throw new ToolError('question_closed', 'Ya estaba contestada.', undefined, 409);
  const now = Date.now();
  hub.tx(() => {
    run(hub.db, `UPDATE questions SET state = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?`, answer, answeredBy, now, id);
    run(
      hub.db,
      `INSERT INTO messages (id, kind, from_session, from_label, to_session, mode, body, context, state, created_at)
       VALUES (?, 'human', NULL, ?, ?, 'response', ?, ?, 'queued', ?)`,
      newId('msg'), `human:${answeredBy}`, q.session_id, answer, JSON.stringify([{ kind: 'question', title: q.question.slice(0, 200), uri: `intercom://questions/${id}` }]), now,
    );
  });
  hub.wake(q.session_id);
  return { id, state: 'answered' };
}
