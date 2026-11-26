import { resolvePeer } from './peers.ts';
import { decide, heldNote, loopStep, systemNotice, type Decision, type HeldReason } from './policy.ts';
import { all, audit, labelOf, one, run, type Ctx, type Hub, type SessionFull, type SessionRow } from './store.ts';
import { clamp, iso, newId, parseJson, ToolError } from './util.ts';

interface MsgRow {
  id: string;
  kind: string;
  from_session: string | null;
  from_label: string;
  to_session: string;
  mode: string;
  body: string;
  context: string;
  response_to: string | null;
  channel_id: string | null;
  thread_id: string | null;
  state: string;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  expires_at: number | null;
  idempotency_key: string | null;
  wake: number;
  held_reason: string | null;
}

export interface ContextItem {
  kind: string;
  title: string;
  mediaType?: string;
  text?: string;
  uri?: string;
}

const MODES = ['notify', 'request', 'response'];

export function cleanContext(raw: unknown): ContextItem[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ToolError('bad_request', '`context` debe ser una lista.');
  if (raw.length > 10) throw new ToolError('bad_request', '`context` admite como máximo 10 elementos.');
  return raw.map((it, i) => {
    const o = it as Record<string, unknown>;
    if (!o || typeof o.kind !== 'string' || typeof o.title !== 'string') throw new ToolError('bad_request', `context[${i}] necesita kind y title.`);
    const out: ContextItem = { kind: o.kind.slice(0, 40), title: o.title.slice(0, 200) };
    if (typeof o.mediaType === 'string') out.mediaType = o.mediaType.slice(0, 100);
    if (typeof o.text === 'string') out.text = o.text.slice(0, 8000);
    if (typeof o.uri === 'string') out.uri = o.uri.slice(0, 500);
    return out;
  });
}

export const pendingCount = (ctx: Ctx, sessionId: string): number =>
  one<{ n: number }>(ctx.hub.db, `SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND state IN ('queued','delivered')`, sessionId)!.n;

const sessionById = (ctx: Ctx, id: string): SessionFull | undefined =>
  one<SessionFull>(
    ctx.hub.db,
    `SELECT s.*, a.display_name AS display_name, a.kind AS agent_kind FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ? AND s.retired_at IS NULL AND a.disabled_at IS NULL`,
    id,
  );

export interface SendArgs {
  peer?: string;
  message: string;
  mode?: string;
  responseTo?: string;
  context?: unknown;
  expiresInMs?: number;
  idempotencyKey?: string;
}

/** `message_peer`: deja un mensaje durable en el buzón de UNA sesión concreta (o de todas, con `agente/*`). */
export function sendMessage(ctx: Ctx, a: SendArgs) {
  const { hub, now, session } = ctx;
  const mode = a.mode ?? (a.responseTo ? 'response' : 'notify');
  if (!MODES.includes(mode)) throw new ToolError('bad_request', 'mode debe ser notify, request o response.');
  if (a.responseTo && mode !== 'response') throw new ToolError('bad_request', 'responseTo exige mode "response".');
  if (mode === 'response' && !a.responseTo) throw new ToolError('bad_request', 'mode "response" exige responseTo.');
  if (a.message.length > hub.cfg.maxMessageChars) {
    throw new ToolError('message_too_large', `El mensaje pasa de ${hub.cfg.maxMessageChars} caracteres; sube un adjunto y referencia su URI.`, undefined, 413);
  }
  const context = cleanContext(a.context);
  if (a.expiresInMs !== undefined && (!Number.isInteger(a.expiresInMs) || a.expiresInMs < 1000)) {
    throw new ToolError('bad_request', 'expiresInMs debe ser un entero de al menos 1000.');
  }
  const expiresAt = a.expiresInMs ? now + a.expiresInMs : null;

  let targets: SessionFull[];
  let fanOut = false;
  if (a.responseTo) {
    const orig = one<MsgRow>(hub.db, 'SELECT * FROM messages WHERE id = ?', a.responseTo);
    if (!orig || orig.to_session !== session.id) {
      throw new ToolError('not_recipient', 'Solo puedes responder a un mensaje que recibió ESTA sesión.', undefined, 404);
    }
    if (!orig.from_session) throw new ToolError('no_reply_target', 'Ese mensaje no viene de una sesión; no admite respuesta.');
    const t = sessionById(ctx, orig.from_session);
    if (!t) throw new ToolError('unknown_peer', 'La sesión que envió el mensaje original ya no existe.', undefined, 404);
    if (a.peer) {
      const asked = resolvePeer(ctx, a.peer);
      if (asked.length !== 1 || asked[0]!.id !== t.id) throw new ToolError('peer_mismatch', `La respuesta debe ir a ${labelOf(t)}, no a «${a.peer}».`);
    }
    targets = [t];
  } else {
    if (!a.peer) throw new ToolError('bad_request', 'Falta `peer` (p. ej. "ana/proyecto-a").');
    targets = resolvePeer(ctx, a.peer);
    fanOut = a.peer.trim().endsWith('/*');
    targets = targets.filter((t) => t.id !== session.id);
    if (!targets.length) throw new ToolError('cannot_message_self', 'No hay otra sesión a la que enviar (no puedes escribirte a ti mismo).');
  }

  // Es la respuesta a algo que el destinatario preguntó: salta su modo hold y su lista de remitentes (no el tope ni el freno).
  const solicited = !!a.responseTo;
  const me = labelOf(session);
  const refused: string[] = [];
  const sent = hub.tx(() =>
    targets.flatMap((t) => {
      if (a.idempotencyKey) {
        const prev = one<MsgRow>(hub.db, 'SELECT * FROM messages WHERE from_session = ? AND to_session = ? AND idempotency_key = ?', session.id, t.id, a.idempotencyKey);
        if (prev) return [{ target: t, row: prev, fresh: false }];
      }
      if (pendingCount(ctx, t.id) >= hub.cfg.maxPendingPerSession) {
        throw new ToolError('inbox_full', `El buzón de ${labelOf(t)} tiene ${hub.cfg.maxPendingPerSession} mensajes sin atender; no admite más por ahora.`, { peer: labelOf(t) }, 429);
      }
      let d: Decision;
      try {
        d = decide(hub, t, me, solicited, now);
      } catch (e) {
        // En un envío a «agente/*», una sesión en «off» se salta; a una sola, es un error claro.
        if (fanOut && e instanceof ToolError && e.code === 'peer_not_accepting') {
          refused.push(labelOf(t));
          return [];
        }
        throw e;
      }
      const loop = loopStep(hub, session.id, t.id, now);
      if (loop.paused) d = { wake: false, reason: 'freno_de_bucle' };
      if (loop.justPaused) {
        const note = `Conversación pausada entre ${me} y ${labelOf(t)}: ${loop.count} mensajes seguidos sin que intervenga una persona. Los mensajes siguen guardándose, pero no despiertan a nadie hasta que una persona escriba en uno de los dos chats o pulse «Reanudar» en el panel.`;
        systemNotice(hub, session.id, note, now);
        systemNotice(hub, t.id, note, now);
        audit(hub, ctx.agent.id, session.id, 'loop_paused', `${me} <-> ${labelOf(t)} (${loop.count})`);
      }
      const id = newId('msg');
      run(
        hub.db,
        `INSERT INTO messages (id, kind, from_session, from_label, to_session, mode, body, context, response_to, state, created_at, expires_at, idempotency_key, wake, held_reason)
         VALUES (?, 'direct', ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        id, session.id, me, t.id, mode, a.message, JSON.stringify(context), a.responseTo ?? null, now, expiresAt, a.idempotencyKey ?? null, d.wake ? 1 : 0, d.reason,
      );
      return [{ target: t, row: one<MsgRow>(hub.db, 'SELECT * FROM messages WHERE id = ?', id)!, fresh: true }];
    }),
  );
  for (const s of sent) {
    if (!s.fresh) continue;
    audit(hub, ctx.agent.id, session.id, 'message_sent', `${s.row.id} -> ${labelOf(s.target)}${s.row.wake ? '' : ` (retenido: ${s.row.held_reason})`}`);
    hub.wake(s.target.id, s.row.wake === 1);
  }
  const view = (s: (typeof sent)[number]) => ({
    messageId: s.row.id,
    to: labelOf(s.target),
    state: s.row.state,
    acceptedAt: iso(s.row.created_at),
    duplicate: !s.fresh,
    // wakes: el mensaje despierta al destinatario (si recibe en automático). false: queda en su buzón, con el motivo.
    wakes: s.row.wake === 1,
    ...(s.row.wake ? {} : { heldReason: s.row.held_reason, note: heldNote(s.row.held_reason as HeldReason, labelOf(s.target)) }),
  });
  if (!fanOut && sent.length === 1) return view(sent[0]!);
  return { count: sent.length, messages: sent.map(view), ...(refused.length ? { refused, refusedReason: 'peer_not_accepting' } : {}) };
}

type NotifyTarget = Pick<SessionRow, 'id' | 'inbound' | 'wake_per_hour' | 'allow_from'>;

/**
 * Avisos a varias sesiones (canales, tareas): respetan la política de entrada de cada una. Las que están en «off» o
 * con el buzón lleno no lo reciben. Llamar dentro de una transacción; devuelve a quién despertar después.
 */
export function enqueueNotices(
  hub: Hub,
  from: { sessionId: string; label: string },
  targets: NotifyTarget[],
  n: { kind: 'channel' | 'task'; body: string; context: ContextItem[]; channelId?: string | null; threadId?: string | null },
  now: number,
): { wake: { id: string; push: boolean }[]; skipped: number } {
  const wake: { id: string; push: boolean }[] = [];
  let skipped = 0;
  for (const t of targets) {
    const full = one<{ n: number }>(hub.db, `SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND state IN ('queued','delivered')`, t.id)!.n >= hub.cfg.maxPendingPerSession;
    if (t.inbound === 'off' || full) {
      skipped++;
      continue;
    }
    const d = decide(hub, t, from.label, false, now);
    run(
      hub.db,
      `INSERT INTO messages (id, kind, from_session, from_label, to_session, mode, body, context, channel_id, thread_id, state, created_at, wake, held_reason)
       VALUES (?, ?, ?, ?, ?, 'notify', ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      newId('msg'), n.kind, from.sessionId, from.label, t.id, n.body, JSON.stringify(n.context), n.channelId ?? null, n.threadId ?? null, now, d.wake ? 1 : 0, d.reason,
    );
    wake.push({ id: t.id, push: d.wake });
  }
  return { wake, skipped };
}

const msgView = (m: MsgRow, ctx: Ctx, redelivered: boolean) => ({
  id: m.id,
  scopeId: ctx.hub.cfg.scope,
  from: m.from_label,
  fromSession: m.from_session,
  to: labelOf(ctx.session),
  mode: m.mode,
  kind: m.kind,
  body: m.body,
  context: parseJson<ContextItem[]>(m.context, []),
  responseTo: m.response_to,
  channelId: m.channel_id,
  threadId: m.thread_id,
  state: m.state,
  // wake false: llegó retenido (política hold, remitente no permitido, tope por hora o freno de bucle) y no despertó a nadie.
  wake: m.wake === 1,
  heldReason: m.held_reason,
  redelivered,
  createdAt: iso(m.created_at),
  deliveredAt: iso(m.delivered_at),
});

/**
 * `check_inbox`: los mensajes pendientes de ESTA sesión. Entrega "al menos una vez": lo que no se confirme con
 * `acknowledge_messages` vuelve a salir (con `redelivered: true`), así un agente que se cae no pierde nada.
 */
export async function checkInbox(ctx: Ctx, args: { limit?: number; waitMs?: number; peek?: boolean; afterId?: string }) {
  const { hub, session } = ctx;
  const limit = args.limit ? clamp(args.limit, 1, 100) : 50;
  const waitMs = clamp(args.waitMs ?? 0, 0, 25000);
  const fetchRows = (): MsgRow[] => {
    run(hub.db, `UPDATE messages SET state = 'expired' WHERE to_session = ? AND state IN ('queued','delivered') AND expires_at IS NOT NULL AND expires_at <= ?`, session.id, Date.now());
    // afterId: solo lo posterior a ese mensaje (cursor del vigilante, para esperar SOLO lo nuevo sin dar vueltas).
    const cursor = args.afterId ? one<{ rowid: number }>(hub.db, 'SELECT rowid FROM messages WHERE id = ? AND to_session = ?', args.afterId, session.id) : undefined;
    return all<MsgRow>(
      hub.db,
      `SELECT * FROM messages WHERE to_session = ? AND state IN ('queued','delivered') ${cursor ? 'AND rowid > ?' : ''} ORDER BY created_at, rowid LIMIT ?`,
      session.id, ...(cursor ? [cursor.rowid] : []), limit,
    );
  };
  let rows = fetchRows();
  if (!rows.length && waitMs > 0) {
    if ((hub.waiters.get(session.id)?.size ?? 0) >= hub.cfg.maxWaitersPerSession) {
      throw new ToolError('too_many_waits', 'Esta sesión ya tiene demasiadas esperas abiertas (check_inbox con waitMs).', undefined, 429);
    }
    await hub.wait(session.id, waitMs, ctx.signal);
    rows = fetchRows();
  }
  const t = Date.now();
  const out = rows.map((m) => {
    const redelivered = m.state === 'delivered';
    // peek: mira sin marcar «delivered» (lo usa el vigilante, que solo avisa; quien procesa es el agente).
    if (!redelivered && !args.peek) {
      run(hub.db, `UPDATE messages SET state = 'delivered', delivered_at = ? WHERE id = ?`, t, m.id);
      m = { ...m, state: 'delivered', delivered_at: t };
    }
    return msgView(m, ctx, redelivered);
  });
  return { acknowledgement: 'Llama a acknowledge_messages con los id ya procesados; si no, volverán a salir.', count: out.length, messages: out };
}

/**
 * Los mensajes retenidos (no despertaron a nadie) que esta sesión aún no confirmó: se marcan entregados y se devuelven
 * para que el hook del turno humano los meta en el chat. Al menos una vez, como check_inbox: un oyente que ya los vio con
 * check_inbox no los hace desaparecer de aquí, y cada cliente descarta los que ya metió en su chat. Hay que confirmarlos.
 */
export function takeHeld(ctx: Ctx, limit: number) {
  const { hub, session } = ctx;
  const rows = all<MsgRow>(
    hub.db,
    `SELECT * FROM messages WHERE to_session = ? AND state IN ('queued','delivered') AND wake = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid LIMIT ?`,
    session.id, Date.now(), clamp(limit, 1, 100),
  );
  const t = Date.now();
  for (const m of rows) if (m.state === 'queued') run(hub.db, `UPDATE messages SET state = 'delivered', delivered_at = ? WHERE id = ?`, t, m.id);
  return { count: rows.length, messages: rows.map((m) => msgView(m.state === 'queued' ? { ...m, state: 'delivered', delivered_at: t } : m, ctx, m.state === 'delivered')) };
}

export function acknowledge(ctx: Ctx, ids: string[]) {
  if (ids.length > 200) throw new ToolError('bad_request', 'Máximo 200 ids por llamada.');
  let n = 0;
  const t = Date.now();
  for (const id of ids) {
    n += Number(run(ctx.hub.db, `UPDATE messages SET state = 'acknowledged', acked_at = ? WHERE id = ? AND to_session = ? AND state IN ('queued','delivered')`, t, id, ctx.session.id).changes);
  }
  return { acknowledged: n };
}

export function receipt(ctx: Ctx, messageId: string) {
  const m = one<MsgRow>(ctx.hub.db, 'SELECT * FROM messages WHERE id = ?', messageId);
  if (!m || (m.from_session !== ctx.session.id && m.to_session !== ctx.session.id)) {
    throw new ToolError('unknown_message', 'No existe ese mensaje (o no es tuyo).', undefined, 404);
  }
  const to = one<{ agent_id: string; name: string }>(ctx.hub.db, 'SELECT agent_id, name FROM sessions WHERE id = ?', m.to_session);
  const reply = one<{ id: string; state: string }>(ctx.hub.db, 'SELECT id, state FROM messages WHERE response_to = ? ORDER BY created_at LIMIT 1', m.id);
  return {
    messageId: m.id,
    from: m.from_label,
    to: to ? labelOf(to) : m.to_session,
    mode: m.mode,
    state: m.state,
    acceptedAt: iso(m.created_at),
    deliveredAt: iso(m.delivered_at),
    acknowledgedAt: iso(m.acked_at),
    response: reply ? { messageId: reply.id, state: reply.state } : null,
  };
}
