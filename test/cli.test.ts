import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../src/db.ts';
import { maintenance } from '../src/admin.ts';
import { loadConfig } from '../src/config.ts';
import { Hub, run } from '../src/store.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('CLI y mantenimiento', () => {
  it('alta de agente, clave fijada a sesión, importación de una clave existente y revocación', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intercom-'));
    const env = { ...process.env, INTERCOM_DB: join(dir, 'x.db') };
    const cli = (...a: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...a], { env, encoding: 'utf8' });
    try {
      cli('agent:add', 'ana', '--name', 'Ana Torres');
      const out = cli('key:add', 'ana', '--session', 'proyecto-a', '--label', 'ana-hosp');
      assert.match(out, /aik_[A-Za-z0-9_-]{20,}/);
      assert.match(out, /proyecto-a/);
      writeFileSync(join(dir, 'vieja.key'), 'obg_Cgn62Z29xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n');
      assert.match(cli('key:import', 'ana', '--file', join(dir, 'vieja.key'), '--label', 'heredada'), /importada/);
      assert.throws(() => cli('key:import', 'ana', '--file', join(dir, 'vieja.key')), /ya está registrada/);
      const keys = JSON.parse(cli('key:list', '--json'));
      assert.equal(keys.length, 2);
      assert.equal(keys.find((k: { label: string }) => k.label === 'ana-hosp').pinnedSession, 'proyecto-a');
      cli('key:revoke', 'heredada');
      assert.equal(JSON.parse(cli('key:list', '--json')).filter((k: { revoked: boolean }) => k.revoked).length, 1);
      assert.equal(JSON.parse(cli('agent:list', '--json'))[0].keys, 1);
      assert.throws(() => cli('agent:add', 'Mal Id'), /id usa minúsculas/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mantenimiento: borra lo cerrado y viejo, conserva lo pendiente', () => {
    const hub = new Hub(loadConfig({}, { retentionDays: 30 }), openDb(':memory:'));
    const old = Date.now() - 40 * 86_400_000;
    run(hub.db, `INSERT INTO agents (id, display_name, created_at) VALUES ('a','a',1)`);
    run(hub.db, `INSERT INTO sessions (id, agent_id, name, created_at, last_seen_at) VALUES ('ses_1','a','s',1,1)`);
    for (const [id, state] of [['m1', 'acknowledged'], ['m2', 'queued'], ['m3', 'expired']] as const) {
      run(hub.db, `INSERT INTO messages (id, from_label, to_session, mode, body, state, created_at) VALUES (?, 'x', 'ses_1', 'notify', 'b', ?, ?)`, id, state, old);
    }
    assert.equal(maintenance(hub).messages, 2);
    assert.equal((hub.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 1);
    hub.db.close();
  });
});
