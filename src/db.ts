import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Migraciones en orden. `PRAGMA user_version` guarda cuántas se aplicaron; nunca se edita una ya publicada,
 * se añade otra al final.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE agents (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'agent',
    created_at   INTEGER NOT NULL,
    disabled_at  INTEGER
  );

  CREATE TABLE api_keys (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL REFERENCES agents(id),
    key_hash       TEXT NOT NULL UNIQUE,
    label          TEXT,
    pinned_session TEXT,
    created_at     INTEGER NOT NULL,
    revoked_at     INTEGER,
    last_used_at   INTEGER
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id),
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    harness      TEXT,
    cwd          TEXT,
    status_text  TEXT NOT NULL DEFAULT '',
    lifecycle    TEXT NOT NULL DEFAULT 'idle',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    retired_at   INTEGER,
    UNIQUE (agent_id, name)
  );

  CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'direct',
    from_session    TEXT REFERENCES sessions(id),
    from_label      TEXT NOT NULL,
    to_session      TEXT NOT NULL REFERENCES sessions(id),
    mode            TEXT NOT NULL,
    body            TEXT NOT NULL,
    context         TEXT NOT NULL DEFAULT '[]',
    response_to     TEXT,
    channel_id      TEXT,
    thread_id       TEXT,
    state           TEXT NOT NULL DEFAULT 'queued',
    created_at      INTEGER NOT NULL,
    delivered_at    INTEGER,
    acked_at        INTEGER,
    expires_at      INTEGER,
    idempotency_key TEXT,
    UNIQUE (from_session, to_session, idempotency_key)
  );
  CREATE INDEX messages_inbox ON messages (to_session, state, created_at);
  CREATE INDEX messages_reply ON messages (response_to);

  CREATE TABLE channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE channel_posts (
    id              TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL REFERENCES channels(id),
    thread_id       TEXT,
    author_session  TEXT REFERENCES sessions(id),
    author_label    TEXT NOT NULL,
    body            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    idempotency_key TEXT,
    UNIQUE (author_session, idempotency_key)
  );
  CREATE INDEX channel_posts_ch ON channel_posts (channel_id);

  CREATE TABLE channel_subs (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    channel_id TEXT NOT NULL REFERENCES channels(id),
    PRIMARY KEY (session_id, channel_id)
  );

  CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT 'open',
    deps          TEXT NOT NULL DEFAULT '[]',
    created_by    TEXT NOT NULL,
    claimed_by    TEXT,
    claimed_session TEXT,
    result        TEXT,
    created_at    INTEGER NOT NULL,
    claimed_at    INTEGER,
    completed_at  INTEGER
  );

  CREATE TABLE task_progress (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    author     TEXT NOT NULL,
    note       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    media_type  TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    data        BLOB NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE questions (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    asked_by    TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     TEXT,
    state       TEXT NOT NULL DEFAULT 'open',
    answer      TEXT,
    answered_by TEXT,
    created_at  INTEGER NOT NULL,
    answered_at INTEGER
  );

  CREATE TABLE audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    agent_id   TEXT,
    session_id TEXT,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT ''
  );
  `,
  // 2: flujos de salida (publish_output / read_output)
  `
  CREATE TABLE output_streams (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    owner_agent TEXT NOT NULL REFERENCES agents(id),
    writers     TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE outputs (
    stream_id    TEXT NOT NULL REFERENCES output_streams(id),
    seq          INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    value        TEXT NOT NULL,
    reference    TEXT,
    author       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (stream_id, seq)
  );
  `,
  // 3: conexiones MCP con estado (una por chat abierto: Mcp-Session-Id) y entrega automática (push)
  `
  CREATE TABLE connections (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL REFERENCES agents(id),
    key_id         TEXT NOT NULL,
    session_id     TEXT REFERENCES sessions(id),
    client_name    TEXT NOT NULL DEFAULT '',
    client_version TEXT NOT NULL DEFAULT '',
    capabilities   TEXT NOT NULL DEFAULT '{}',
    protocol       TEXT NOT NULL DEFAULT '',
    instance       TEXT,
    suggest        TEXT,
    cwd            TEXT,
    harness        TEXT,
    channels       INTEGER,
    naming         TEXT NOT NULL DEFAULT 'pending',
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    closed_at      INTEGER
  );
  CREATE INDEX connections_session ON connections (session_id, closed_at);
  CREATE INDEX connections_instance ON connections (agent_id, instance);
  ALTER TABLE sessions ADD COLUMN streams INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN push_streams INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN pushed_at INTEGER;
  ALTER TABLE messages ADD COLUMN pushed_conn TEXT;
  `,
  // 4: equipo con seats separados. Política de entrada por sesión (quién y cuántas veces puede despertarla), freno de
  //    bucles entre dos sesiones, tareas con etiquetas, preguntas a una persona concreta, panel web e invitaciones.
  `
  ALTER TABLE sessions ADD COLUMN inbound TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE sessions ADD COLUMN wake_per_hour INTEGER;
  ALTER TABLE sessions ADD COLUMN allow_from TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE messages ADD COLUMN wake INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE messages ADD COLUMN held_reason TEXT;
  CREATE INDEX messages_wake ON messages (to_session, wake, created_at);
  CREATE INDEX messages_pair ON messages (from_session, to_session, created_at);

  CREATE TABLE pair_guard (
    a         TEXT NOT NULL,
    b         TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    last_at   INTEGER NOT NULL,
    paused_at INTEGER,
    PRIMARY KEY (a, b)
  );

  ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN created_session TEXT;
  ALTER TABLE questions ADD COLUMN person TEXT;

  CREATE TABLE web_sessions (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id),
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE web_links (
    token_hash TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL REFERENCES agents(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );

  CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL REFERENCES agents(id),
    token_hash TEXT NOT NULL UNIQUE,
    label      TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    key_id     TEXT
  );
  `,
];

/** Versión de esquema que conoce este servidor (una copia más nueva no se restaura). */
export const MIGRATION_COUNT = MIGRATIONS.length;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = row.user_version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
