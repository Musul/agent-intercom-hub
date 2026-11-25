import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Config } from './config.ts';

export type Presence = 'online' | 'recent' | 'away';

export interface AgentRow {
  id: string;
  display_name: string;
  kind: string;
  created_at: number;
  disabled_at: number | null;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  tags: string;
  harness: string | null;
  cwd: string | null;
  status_text: string;
  lifecycle: string;
  created_at: number;
  last_seen_at: number;
  retired_at: number | null;
}

export interface SessionFull extends SessionRow {
  display_name: string;
  agent_kind: string;
}

/** Una conexión SSE abierta de una sesión (GET /mcp): es lo que prueba que está «online» de verdad. */
export interface StreamClient {
  write(chunk: string): void;
  end(): void;
}

/** Quién llama, resuelto por la clave (agente) y la cabecera X-Session-Name (sesión). */
export interface Ctx {
  hub: Hub;
  agent: AgentRow;
  session: SessionRow;
  keyId: string;
  warnings: string[];
  now: number;
  signal?: AbortSignal | undefined;
}

export const all = <T>(db: DatabaseSync, sql: string, ...p: SQLInputValue[]): T[] => db.prepare(sql).all(...p) as unknown as T[];
export const one = <T>(db: DatabaseSync, sql: string, ...p: SQLInputValue[]): T | undefined =>
  db.prepare(sql).get(...p) as unknown as T | undefined;
export const run = (db: DatabaseSync, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

export const labelOf = (s: { agent_id: string; name: string }): string => `${s.agent_id}/${s.name}`;

export class Hub {
  db: DatabaseSync;
  cfg: Config;
  streams = new Map<string, Set<StreamClient>>();
  waiters = new Map<string, Set<() => void>>();
  lastTouch = new Map<string, number>();
  /** Subidas REST en curso (tope para no agotar la memoria con cuerpos grandes a la vez). */
  activeUploads = 0;
  activeDownloads = 0;

  constructor(cfg: Config, db: DatabaseSync) {
    this.cfg = cfg;
    this.db = db;
  }

  /** Transacción simple (SQLite es síncrono y el proceso tiene un solo hilo: no se anidan). */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  presence(sessionId: string, lastSeenAt: number, now: number): Presence {
    if ((this.streams.get(sessionId)?.size ?? 0) > 0) return 'online';
    return now - lastSeenAt <= this.cfg.recentMs ? 'recent' : 'away';
  }

  addStream(sessionId: string, c: StreamClient): void {
    let set = this.streams.get(sessionId);
    if (!set) this.streams.set(sessionId, (set = new Set()));
    set.add(c);
  }

  removeStream(sessionId: string, c: StreamClient): void {
    const set = this.streams.get(sessionId);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.streams.delete(sessionId);
  }

  /** Despierta al `check_inbox` en espera de esta sesión y avisa por SSE a quien tenga la conexión abierta. */
  wake(sessionId: string): void {
    const w = this.waiters.get(sessionId);
    if (w) {
      for (const fn of [...w]) fn();
      this.waiters.delete(sessionId);
    }
    const s = this.streams.get(sessionId);
    if (s?.size) {
      const pending = (one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM messages WHERE to_session = ? AND state IN ('queued','delivered')`, sessionId)?.n) ?? 0;
      const note = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', logger: 'intercom', data: { event: 'inbox', pending } },
      });
      for (const c of s) c.write(`event: message\ndata: ${note}\n\n`);
    }
  }

  /** Espera hasta `ms` o hasta que llegue algo (o se corte la conexión del cliente). */
  wait(sessionId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(sessionId);
      if (!set) this.waiters.set(sessionId, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        set!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  close(): void {
    for (const set of this.streams.values()) for (const c of set) c.end();
    this.streams.clear();
    for (const set of this.waiters.values()) for (const f of [...set]) f();
    this.waiters.clear();
  }
}

export function audit(hub: Hub, agentId: string | null, sessionId: string | null, action: string, detail = ''): void {
  run(hub.db, 'INSERT INTO audit (at, agent_id, session_id, action, detail) VALUES (?,?,?,?,?)', Date.now(), agentId, sessionId, action, detail);
}
