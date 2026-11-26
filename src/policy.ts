/**
 * Quién puede despertar a una sesión, y cuántas veces.
 *
 * Con un seat por persona, cada mensaje que despierta a un chat gasta la cuota de SU dueño, lo mande quien lo mande.
 * Por eso cada sesión decide:
 *   - `inbound`: auto (los mensajes la despiertan) · hold (esperan a que su usuario escriba) · off (no admite mensajes,
 *     salvo respuestas a lo que ella preguntó);
 *   - `allow_from`: quién puede despertarla ("ana", "ana/*", "ana/api"); los demás quedan en cola sin despertarla;
 *   - `wake_per_hour`: tope de mensajes por hora que la despiertan (el resto queda en cola).
 * Y el freno de bucles: si dos sesiones se escriben más de N idas y vueltas sin que intervenga una persona, la
 * conversación se pausa (los mensajes siguen guardándose, pero no despiertan a nadie) hasta que una persona la retome.
 *
 * Un mensaje retenido NUNCA se pierde: queda en el buzón y sale en check_inbox, en el siguiente turno del usuario
 * (hooks) o en el panel web.
 */
import { all, audit, labelOf, one, run, type Hub, type SessionRow } from './store.ts';
import { iso, newId, norm, parseJson, ToolError } from './util.ts';

export const INBOUND = ['auto', 'hold', 'off'] as const;
export type Inbound = (typeof INBOUND)[number];

/** Por qué un mensaje no despertó a su destinatario. */
export type HeldReason = 'retenido_por_politica' | 'remitente_no_permitido' | 'tope_por_hora' | 'freno_de_bucle';

export interface Decision {
  wake: boolean;
  reason: HeldReason | null;
}

type PolicyTarget = Pick<SessionRow, 'id' | 'inbound' | 'wake_per_hour' | 'allow_from'>;

/** ¿Encaja `agente/sesion` con alguno de los patrones ("ana", "ana/*", "ana/api")? */
export function senderAllowed(patterns: string[], fromLabel: string): boolean {
  if (!patterns.length) return true;
  const agent = fromLabel.split('/')[0] ?? '';
  return patterns.some((p) => p === fromLabel || p === agent || p === `${agent}/*`);
}

/** Tope efectivo de la sesión (0 = sin tope). */
export const wakeCap = (hub: Hub, t: Pick<SessionRow, 'wake_per_hour'>): number => (t.wake_per_hour ?? hub.cfg.wakePerHour);

/**
 * Decide si un mensaje para `t` la despierta. `solicited`: es la respuesta a algo que `t` preguntó (salta `hold` y
 * `allow_from`, no el tope ni el freno). Lanza `peer_not_accepting` si la sesión está en `off` y no es una respuesta.
 */
export function decide(hub: Hub, t: PolicyTarget, fromLabel: string, solicited: boolean, now: number): Decision {
  const inbound = (INBOUND as readonly string[]).includes(t.inbound) ? (t.inbound as Inbound) : 'auto';
  if (inbound === 'off' && !solicited) {
    throw new ToolError('peer_not_accepting', 'Esa sesión no admite mensajes ahora (su usuario la puso en «off»). Prueba con otra sesión de esa persona o espera.', undefined, 403);
  }
  if (!solicited) {
    if (inbound === 'hold') return { wake: false, reason: 'retenido_por_politica' };
    if (!senderAllowed(parseJson<string[]>(t.allow_from, []), fromLabel)) return { wake: false, reason: 'remitente_no_permitido' };
  }
  const cap = wakeCap(hub, t);
  if (cap > 0) {
    const n = one<{ n: number }>(
      hub.db,
      'SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND wake = 1 AND from_session IS NOT NULL AND created_at > ?',
      t.id, now - 3_600_000,
    )!.n;
    if (n >= cap) return { wake: false, reason: 'tope_por_hora' };
  }
  return { wake: true, reason: null };
}

/** Una línea que explica al remitente qué pasó con su mensaje retenido. */
export function heldNote(reason: HeldReason, to: string): string {
  switch (reason) {
    case 'retenido_por_politica':
      return `${to} está en modo «hold»: tu mensaje queda en su buzón y lo verá cuando su usuario escriba. No insistas.`;
    case 'remitente_no_permitido':
      return `${to} solo se despierta con mensajes de remitentes permitidos: el tuyo queda en su buzón para cuando su usuario escriba.`;
    case 'tope_por_hora':
      return `${to} alcanzó su tope de mensajes por hora: el tuyo queda en cola sin despertarla. Agrupa lo que tengas que decirle.`;
    case 'freno_de_bucle':
      return `Conversación pausada: ${to} y tú lleváis demasiados mensajes seguidos sin que intervenga una persona. El mensaje queda en cola; se reanuda cuando una persona escriba en uno de los dos chats o pulse «Reanudar» en el panel. Avisa a tu usuario y no insistas.`;
  }
}

const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

interface GuardRow {
  a: string;
  b: string;
  count: number;
  last_at: number;
  paused_at: number | null;
}

/**
 * Cuenta un mensaje directo entre dos sesiones. Devuelve si la conversación está pausada y si se pausó AHORA (para
 * avisar una sola vez). El contador vuelve a cero tras `loopResetMs` sin mensajes o con un turno humano.
 */
export function loopStep(hub: Hub, from: string, to: string, now: number): { paused: boolean; justPaused: boolean; count: number } {
  const limit = hub.cfg.loopMaxExchanges * 2;
  const [a, b] = pairOf(from, to);
  const row = one<GuardRow>(hub.db, 'SELECT * FROM pair_guard WHERE a = ? AND b = ?', a, b);
  const fresh = !row || now - row.last_at > hub.cfg.loopResetMs;
  const count = (fresh ? 0 : row.count) + 1;
  const wasPaused = !fresh && row.paused_at !== null;
  const justPaused = !wasPaused && limit > 0 && count > limit;
  const pausedAt = wasPaused ? row!.paused_at : justPaused ? now : null;
  run(
    hub.db,
    `INSERT INTO pair_guard (a, b, count, last_at, paused_at) VALUES (?,?,?,?,?)
     ON CONFLICT (a, b) DO UPDATE SET count = excluded.count, last_at = excluded.last_at, paused_at = excluded.paused_at`,
    a, b, count, now, pausedAt,
  );
  return { paused: pausedAt !== null, justPaused, count };
}

/** Aviso del servidor (no despierta a nadie): queda en el buzón y en el panel. */
export function systemNotice(hub: Hub, toSession: string, body: string, now: number): void {
  run(
    hub.db,
    `INSERT INTO messages (id, kind, from_session, from_label, to_session, mode, body, context, state, created_at, wake, held_reason)
     VALUES (?, 'system', NULL, 'intercom', ?, 'notify', ?, '[]', 'queued', ?, 0, NULL)`,
    newId('msg'), toSession, body, now,
  );
}

/** Una persona intervino en la sesión (escribió en su chat): se reanudan sus conversaciones pausadas. */
export function humanTurn(hub: Hub, sessionId: string): number {
  return Number(run(hub.db, 'UPDATE pair_guard SET count = 0, paused_at = NULL WHERE a = ? OR b = ?', sessionId, sessionId).changes);
}

/** Reanuda la conversación entre dos sesiones (botón del panel). */
export function resumePair(hub: Hub, x: string, y: string): boolean {
  const [a, b] = pairOf(x, y);
  return Number(run(hub.db, 'UPDATE pair_guard SET count = 0, paused_at = NULL WHERE a = ? AND b = ?', a, b).changes) > 0;
}

/** Conversaciones pausadas por el freno (para el panel y get_node_status). */
export function pausedPairs(hub: Hub, sessionId?: string) {
  const rows = sessionId
    ? all<GuardRow>(hub.db, 'SELECT * FROM pair_guard WHERE paused_at IS NOT NULL AND (a = ? OR b = ?)', sessionId, sessionId)
    : all<GuardRow>(hub.db, 'SELECT * FROM pair_guard WHERE paused_at IS NOT NULL');
  const label = (id: string) => {
    const s = one<{ agent_id: string; name: string }>(hub.db, 'SELECT agent_id, name FROM sessions WHERE id = ?', id);
    return s ? labelOf(s) : id;
  };
  return rows.map((r) => ({ a: label(r.a), b: label(r.b), sessionA: r.a, sessionB: r.b, messages: r.count, pausedAt: iso(r.paused_at), lastAt: iso(r.last_at) }));
}

export interface PolicyArgs {
  inbound?: string;
  wakePerHour?: number | null;
  allowFrom?: string[];
}

/** Valida y guarda la política de entrada de una sesión. */
export function setPolicy(hub: Hub, sessionId: string, a: PolicyArgs, by: string): void {
  if (a.inbound !== undefined && !(INBOUND as readonly string[]).includes(a.inbound)) throw new ToolError('bad_request', 'inbound debe ser auto, hold u off.');
  if (a.wakePerHour !== undefined && a.wakePerHour !== null && (!Number.isInteger(a.wakePerHour) || a.wakePerHour < 0 || a.wakePerHour > 10_000)) {
    throw new ToolError('bad_request', 'wakePerHour debe ser un entero entre 0 (sin tope) y 10000, o null (valor del servidor).');
  }
  let allow: string[] | undefined;
  if (a.allowFrom !== undefined) {
    if (a.allowFrom.length > 50) throw new ToolError('bad_request', 'allowFrom admite como máximo 50 patrones.');
    allow = [...new Set(a.allowFrom.map((p) => norm(p).trim()).filter(Boolean))];
    for (const p of allow) {
      if (!/^[a-z0-9][a-z0-9._-]{0,47}(\/([a-z0-9][a-z0-9._-]{0,47}|\*))?$/.test(p)) {
        throw new ToolError('bad_request', `Patrón no válido: «${p}». Usa "agente", "agente/*" o "agente/sesion".`);
      }
    }
  }
  if (a.inbound !== undefined) run(hub.db, 'UPDATE sessions SET inbound = ? WHERE id = ?', a.inbound, sessionId);
  if (a.wakePerHour !== undefined) run(hub.db, 'UPDATE sessions SET wake_per_hour = ? WHERE id = ?', a.wakePerHour, sessionId);
  if (allow !== undefined) run(hub.db, 'UPDATE sessions SET allow_from = ? WHERE id = ?', JSON.stringify(allow), sessionId);
  audit(hub, null, sessionId, 'inbound_policy', `${by}: ${JSON.stringify(a)}`.slice(0, 300));
}

/** La política tal como la ven el agente y el panel. */
export function policyView(hub: Hub, s: Pick<SessionRow, 'id' | 'inbound' | 'wake_per_hour' | 'allow_from'>, now = Date.now()) {
  const cap = wakeCap(hub, s);
  const used = one<{ n: number }>(
    hub.db, 'SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND wake = 1 AND from_session IS NOT NULL AND created_at > ?', s.id, now - 3_600_000,
  )!.n;
  const held = one<{ n: number }>(hub.db, `SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND wake = 0 AND state IN ('queued','delivered')`, s.id)!.n;
  return {
    inbound: s.inbound,
    allowFrom: parseJson<string[]>(s.allow_from, []),
    wakePerHour: cap,
    wakePerHourSource: s.wake_per_hour === null ? 'servidor' : 'sesion',
    wokenLastHour: used,
    heldPending: held,
  };
}
