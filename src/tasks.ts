import { enqueueNotices } from './inbox.ts';
import { all, audit, labelOf, one, run, type Ctx } from './store.ts';
import { clamp, clip, iso, newId, norm, parseJson, ToolError } from './util.ts';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  state: string;
  deps: string;
  created_by: string;
  claimed_by: string | null;
  claimed_session: string | null;
  result: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  tags: string;
  created_session: string | null;
}

function view(t: TaskRow, states: Map<string, string>) {
  const deps = parseJson<string[]>(t.deps, []);
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    state: t.state,
    tags: parseJson<string[]>(t.tags, []),
    ready: t.state === 'open' && deps.every((d) => states.get(d) === 'done'),
    dependencies: deps.map((d) => ({ id: d, state: states.get(d) ?? 'missing' })),
    createdBy: t.created_by,
    claimedBy: t.claimed_by,
    result: t.result,
    createdAt: iso(t.created_at),
    claimedAt: iso(t.claimed_at),
    completedAt: iso(t.completed_at),
  };
}

const stateMap = (ctx: Ctx) => new Map(all<{ id: string; state: string }>(ctx.hub.db, 'SELECT id, state FROM tasks').map((r) => [r.id, r.state]));
const taskBy = (ctx: Ctx, id: string): TaskRow => {
  const t = one<TaskRow>(ctx.hub.db, 'SELECT * FROM tasks WHERE id = ?', id);
  if (!t) throw new ToolError('unknown_task', `No existe la tarea ${id}.`, undefined, 404);
  return t;
};

/** Etiquetas normalizadas (como las de las sesiones): minúsculas, sin acentos, sin repetir, máx. 10. */
export const cleanTags = (tags: string[] | undefined): string[] => [...new Set((tags ?? []).map((t) => norm(t).trim()).filter(Boolean))].slice(0, 10);

/**
 * Reparto de trabajo: avisa de una tarea a las sesiones cuyas etiquetas coinciden con las de la tarea (salvo a quien
 * la creó). Respeta la política de entrada de cada sesión. Devuelve cuántas se avisaron.
 */
function announce(ctx: Ctx, t: TaskRow, why: 'nueva' | 'lista'): number {
  const tags = parseJson<string[]>(t.tags, []);
  if (!tags.length) return 0;
  const { hub, session, now } = ctx;
  const candidates = all<{ id: string; tags: string; inbound: string; wake_per_hour: number | null; allow_from: string }>(
    hub.db,
    `SELECT s.id, s.tags, s.inbound, s.wake_per_hour, s.allow_from FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.retired_at IS NULL AND a.disabled_at IS NULL AND s.id <> COALESCE(?, '')`,
    t.created_session ?? session.id,
  ).filter((s) => parseJson<string[]>(s.tags, []).some((x) => tags.includes(x)));
  if (!candidates.length) return 0;
  const body = `[tarea ${why === 'nueva' ? 'nueva' : 'lista para reclamar'}] ${t.title} (${t.id}) · etiquetas: ${tags.join(', ')}${t.description ? `
${clip(t.description, 500)}` : ''}
Si te toca, reclámala con claim_task; si no, ignórala.`;
  const r = hub.tx(() =>
    enqueueNotices(hub, { sessionId: session.id, label: labelOf(session) }, candidates, { kind: 'task', body, context: [{ kind: 'task', title: t.title, uri: `intercom://tasks/${t.id}` }] }, now),
  );
  for (const w of r.wake) hub.wake(w.id, w.push);
  return r.wake.length;
}

/** Aviso a la sesión que creó la tarea (completada o devuelta). */
function tellCreator(ctx: Ctx, t: TaskRow, what: string): void {
  if (!t.created_session || t.created_session === ctx.session.id) return;
  const target = one<{ id: string; inbound: string; wake_per_hour: number | null; allow_from: string }>(
    ctx.hub.db, 'SELECT id, inbound, wake_per_hour, allow_from FROM sessions WHERE id = ? AND retired_at IS NULL', t.created_session,
  );
  if (!target) return;
  const r = ctx.hub.tx(() =>
    enqueueNotices(ctx.hub, { sessionId: ctx.session.id, label: labelOf(ctx.session) }, [target], { kind: 'task', body: `[tarea ${what}] ${t.title} (${t.id})${t.result ? `
Resultado: ${clip(t.result, 1000)}` : ''}`, context: [{ kind: 'task', title: t.title, uri: `intercom://tasks/${t.id}` }] }, ctx.now),
  );
  for (const w of r.wake) ctx.hub.wake(w.id, w.push);
}

export function addTask(ctx: Ctx, title: string, description = '', dependencies: string[] = [], tags: string[] = []) {
  const states = stateMap(ctx);
  for (const d of dependencies) if (!states.has(d)) throw new ToolError('unknown_task', `La dependencia ${d} no existe.`, undefined, 404);
  if (one<{ n: number }>(ctx.hub.db, `SELECT COUNT(*) AS n FROM tasks WHERE state != 'done'`)!.n >= ctx.hub.cfg.maxOpenTasks) {
    throw new ToolError('too_many_tasks', 'Hay demasiadas tareas abiertas; completa o limpia algunas.', undefined, 429);
  }
  const id = newId('tsk');
  run(
    ctx.hub.db, 'INSERT INTO tasks (id, title, description, deps, created_by, created_at, tags, created_session) VALUES (?,?,?,?,?,?,?,?)',
    id, title.slice(0, 200), description.slice(0, 4000), JSON.stringify([...new Set(dependencies)]), labelOf(ctx.session), ctx.now, JSON.stringify(cleanTags(tags)), ctx.session.id,
  );
  audit(ctx.hub, ctx.agent.id, ctx.session.id, 'task_added', id);
  const v = view(taskBy(ctx, id), stateMap(ctx));
  // Solo se anuncia lo que ya se puede reclamar; las que esperan dependencias se anuncian al quedar listas.
  const notified = v.ready ? announce(ctx, taskBy(ctx, id), 'nueva') : 0;
  return { ...v, notified };
}

export function listTasks(ctx: Ctx, ready?: boolean, filter: { tag?: string; mine?: boolean; state?: string } = {}) {
  const states = stateMap(ctx);
  let tasks = all<TaskRow>(ctx.hub.db, 'SELECT * FROM tasks ORDER BY created_at, rowid').map((t) => ({ ...view(t, states), claimedSession: t.claimed_session, createdSession: t.created_session }));
  if (ready !== undefined) tasks = tasks.filter((t) => t.ready === ready);
  if (filter.state) tasks = tasks.filter((t) => t.state === filter.state);
  if (filter.tag) {
    const tag = norm(filter.tag).trim();
    tasks = tasks.filter((t) => t.tags.includes(tag));
  }
  if (filter.mine) tasks = tasks.filter((t) => t.claimedSession === ctx.session.id || t.createdSession === ctx.session.id);
  return { tasks: tasks.map(({ claimedSession: _c, createdSession: _s, ...t }) => t) };
}

export function claimTask(ctx: Ctx, id: string) {
  const t = taskBy(ctx, id);
  const v = view(t, stateMap(ctx));
  if (t.state !== 'open') throw new ToolError('task_not_open', `La tarea está «${t.state}»${t.claimed_by ? ` (${t.claimed_by})` : ''}.`, undefined, 409);
  if (!v.ready) throw new ToolError('task_not_ready', 'Tiene dependencias sin completar.', { dependencies: v.dependencies }, 409);
  run(ctx.hub.db, `UPDATE tasks SET state = 'claimed', claimed_by = ?, claimed_session = ?, claimed_at = ? WHERE id = ? AND state = 'open'`, labelOf(ctx.session), ctx.session.id, ctx.now, id);
  return view(taskBy(ctx, id), stateMap(ctx));
}

const mustOwn = (ctx: Ctx, t: TaskRow) => {
  if (t.claimed_session !== ctx.session.id) throw new ToolError('not_claimant', `Solo ${t.claimed_by ?? 'quien la reclamó'} puede hacerlo.`, undefined, 403);
};

export function releaseTask(ctx: Ctx, id: string) {
  const t = taskBy(ctx, id);
  if (t.state !== 'claimed') throw new ToolError('task_not_claimed', 'La tarea no está reclamada.', undefined, 409);
  mustOwn(ctx, t);
  run(ctx.hub.db, `UPDATE tasks SET state = 'open', claimed_by = NULL, claimed_session = NULL, claimed_at = NULL WHERE id = ?`, id);
  const fresh = taskBy(ctx, id);
  tellCreator(ctx, fresh, 'devuelta');
  return view(fresh, stateMap(ctx));
}

export function completeTask(ctx: Ctx, id: string, result = '') {
  const t = taskBy(ctx, id);
  if (t.state !== 'claimed') throw new ToolError('task_not_claimed', 'Reclama la tarea antes de completarla.', undefined, 409);
  mustOwn(ctx, t);
  run(ctx.hub.db, `UPDATE tasks SET state = 'done', result = ?, completed_at = ? WHERE id = ?`, result.slice(0, 4000), ctx.now, id);
  audit(ctx.hub, ctx.agent.id, ctx.session.id, 'task_completed', id);
  const done = taskBy(ctx, id);
  tellCreator(ctx, done, 'completada');
  // Las tareas que dependían de esta y ya quedan listas se anuncian a quien tenga sus etiquetas.
  const states = stateMap(ctx);
  for (const t of all<TaskRow>(ctx.hub.db, `SELECT * FROM tasks WHERE state = 'open' AND deps LIKE ?`, `%${id}%`)) {
    if (view(t, states).ready) announce(ctx, t, 'lista');
  }
  return view(done, states);
}

export function addProgress(ctx: Ctx, id: string, note: string) {
  const t = taskBy(ctx, id);
  if (t.state === 'claimed') mustOwn(ctx, t);
  const pid = newId('prg');
  run(ctx.hub.db, 'INSERT INTO task_progress (id, task_id, author, note, created_at) VALUES (?,?,?,?,?)', pid, id, labelOf(ctx.session), note.slice(0, 2000), ctx.now);
  return { progressId: pid, taskId: id };
}

export function listProgress(ctx: Ctx, id: string, limit?: number) {
  taskBy(ctx, id);
  const rows = all<{ id: string; author: string; note: string; created_at: number }>(
    ctx.hub.db, 'SELECT * FROM task_progress WHERE task_id = ? ORDER BY created_at, rowid LIMIT ?', id, clamp(limit ?? 100, 1, 500),
  );
  return { taskId: id, progress: rows.map((r) => ({ id: r.id, author: r.author, note: r.note, createdAt: iso(r.created_at) })) };
}
