import { all, audit, labelOf, one, run, type Ctx } from './store.ts';
import { clamp, iso, newId, parseJson, ToolError } from './util.ts';

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
}

function view(t: TaskRow, states: Map<string, string>) {
  const deps = parseJson<string[]>(t.deps, []);
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    state: t.state,
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

export function addTask(ctx: Ctx, title: string, description = '', dependencies: string[] = []) {
  const states = stateMap(ctx);
  for (const d of dependencies) if (!states.has(d)) throw new ToolError('unknown_task', `La dependencia ${d} no existe.`, undefined, 404);
  if (one<{ n: number }>(ctx.hub.db, `SELECT COUNT(*) AS n FROM tasks WHERE state != 'done'`)!.n >= ctx.hub.cfg.maxOpenTasks) {
    throw new ToolError('too_many_tasks', 'Hay demasiadas tareas abiertas; completa o limpia algunas.', undefined, 429);
  }
  const id = newId('tsk');
  run(ctx.hub.db, 'INSERT INTO tasks (id, title, description, deps, created_by, created_at) VALUES (?,?,?,?,?,?)', id, title.slice(0, 200), description.slice(0, 4000), JSON.stringify([...new Set(dependencies)]), labelOf(ctx.session), ctx.now);
  audit(ctx.hub, ctx.agent.id, ctx.session.id, 'task_added', id);
  return view(taskBy(ctx, id), stateMap(ctx));
}

export function listTasks(ctx: Ctx, ready?: boolean) {
  const states = stateMap(ctx);
  let tasks = all<TaskRow>(ctx.hub.db, 'SELECT * FROM tasks ORDER BY created_at, rowid').map((t) => view(t, states));
  if (ready !== undefined) tasks = tasks.filter((t) => t.ready === ready);
  return { tasks };
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
  return view(taskBy(ctx, id), stateMap(ctx));
}

export function completeTask(ctx: Ctx, id: string, result = '') {
  const t = taskBy(ctx, id);
  if (t.state !== 'claimed') throw new ToolError('task_not_claimed', 'Reclama la tarea antes de completarla.', undefined, 409);
  mustOwn(ctx, t);
  run(ctx.hub.db, `UPDATE tasks SET state = 'done', result = ?, completed_at = ? WHERE id = ?`, result.slice(0, 4000), ctx.now, id);
  audit(ctx.hub, ctx.agent.id, ctx.session.id, 'task_completed', id);
  return view(taskBy(ctx, id), stateMap(ctx));
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
