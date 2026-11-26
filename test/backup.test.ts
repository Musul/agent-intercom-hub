import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { restoreBackup, scheduledBackup, testRestore, verifyBackup } from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { boot, j, tool, type Booted } from './helpers.ts';

describe('copias programadas, ensayo de restauración y salud', () => {
  let b: Booted;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'intercom-bk-'));
    b = await boot({ backupDir: join(dir, 'copias'), backupKeep: 2, backupEveryHours: 24 });
    const ka = b.agent('ana');
    const kb = b.agent('beto');
    await tool(b.base, kb, 'web', 'get_node_status');
    await tool(b.base, ka, 'api', 'message_peer', { peer: 'beto/web', message: 'pendiente que debe sobrevivir' });
  });
  after(async () => {
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('copia fechada, verificable, y solo se conservan las BACKUP_KEEP más nuevas', () => {
    const files = [0, 1, 2].map((i) => scheduledBackup(b.hub, Date.UTC(2026, 10, 20 + i, 3, 0, 0)).file);
    const left = readdirSync(join(dir, 'copias')).sort();
    assert.deepEqual(left, ['intercom-20261121-030000.db', 'intercom-20261122-030000.db']);
    assert.ok(!existsSync(files[0]!));
    const v = verifyBackup(files[2]!);
    assert.equal(v.integrity, 'ok');
    assert.equal(v.agents, 2);
    assert.equal(v.messages, 1);
  });

  it('ensayo de restauración: abre, migra y lee la copia sin tocar producción', () => {
    const copy = join(dir, 'copias', 'intercom-20261122-030000.db');
    const r = testRestore(copy);
    assert.equal(r.ok, true);
    assert.equal(r.pendingMessages, 1);
    assert.equal(r.sessionsReadable, 2);
  });

  it('restaurar: no pisa sin --force; con --force aparta la base actual y deja los datos', () => {
    const copy = join(dir, 'copias', 'intercom-20261122-030000.db');
    const target = join(dir, 'prod', 'intercom.db');
    restoreBackup(copy, target);
    assert.throws(() => restoreBackup(copy, target), /ya existe/);
    const r = restoreBackup(copy, target, true);
    assert.equal(r.restored, target);
    assert.ok(readdirSync(join(dir, 'prod')).some((f) => f.includes('.pre-restore-')), 'la base anterior queda aparte');
    const db = openDb(target);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE state = 'queued'`).get() as { n: number }).n, 1);
    db.close();
  });

  it('una copia corrupta o inexistente no se da por buena', () => {
    const bad = join(dir, 'mala.db');
    writeFileSync(bad, 'esto no es sqlite');
    assert.throws(() => verifyBackup(bad));
    assert.throws(() => verifyBackup(join(dir, 'no-existe.db')), /No existe/);
  });

  it('/healthz informa de la base y de la última copia', async () => {
    const h = await j(await fetch(`${b.base}/healthz`));
    assert.equal(h.ok, true);
    assert.equal(h.db, 'ok');
    assert.ok(h.lastBackupAt);
    assert.equal(typeof h.backupStale, 'boolean');
  });
});
