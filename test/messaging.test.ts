import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { boot, tool, type Booted } from './helpers.ts';

describe('mensajería, canales, tareas y adjuntos', () => {
  let b: Booted;
  let ka: string;
  let kb: string;
  const A = (name: string, args: Record<string, unknown> = {}) => tool(b.base, ka, 'a', name, args);
  const B = (name: string, args: Record<string, unknown> = {}) => tool(b.base, kb, 'b', name, args);

  before(async () => {
    b = await boot({ ratePerMinute: 10_000 });
    ka = b.agent('ana');
    kb = b.agent('beto');
    await A('get_node_status');
    await B('get_node_status');
  });
  after(() => b.close());

  it('ciclo completo: queued → delivered → acknowledged, con recibo y respuesta enlazada', async () => {
    const sent = await A('message_peer', { peer: 'beto/b', message: '¿me oyes?', mode: 'request', context: [{ kind: 'note', title: 'nota', text: 'hola' }] });
    assert.equal(sent.data.state, 'queued');
    assert.equal((await A('message_receipt', { messageId: sent.data.messageId })).data.state, 'queued');

    const inbox = await B('check_inbox');
    const m = inbox.data.messages[0];
    assert.equal(m.id, sent.data.messageId);
    assert.equal(m.mode, 'request');
    assert.equal(m.redelivered, false);
    assert.equal(m.context[0].title, 'nota');
    assert.equal((await A('message_receipt', { messageId: m.id })).data.state, 'delivered');

    // sin confirmar vuelve a salir
    const again = await B('check_inbox');
    assert.equal(again.data.messages[0].redelivered, true);

    // responde SIN peer: va a la sesión que lo envió
    const reply = await B('message_peer', { message: 'fuerte y claro', responseTo: m.id });
    assert.equal(reply.data.to, 'ana/a');
    assert.equal((await B('acknowledge_messages', { messageIds: [m.id] })).data.acknowledged, 1);
    assert.equal((await B('check_inbox')).data.count, 0);

    const rec = (await A('message_receipt', { messageId: m.id })).data;
    assert.equal(rec.state, 'acknowledged');
    assert.equal(rec.response.messageId, reply.data.messageId);
    const got = await A('check_inbox');
    assert.equal(got.data.messages[0].responseTo, m.id);
    await A('acknowledge_messages', { messageIds: [got.data.messages[0].id] });
  });

  it('solo se responde a mensajes que recibió ESA sesión; el recibo es solo de las partes', async () => {
    const sent = await A('message_peer', { peer: 'beto/b', message: 'privado' });
    assert.equal((await A('message_peer', { message: 'x', responseTo: sent.data.messageId })).data.code, 'not_recipient');
    const stranger = b.agent('carla');
    assert.equal((await tool(b.base, stranger, 'c', 'message_receipt', { messageId: sent.data.messageId })).data.code, 'unknown_message');
    assert.equal((await tool(b.base, kb, 'otra', 'check_inbox')).data.count, 0); // otra sesión de beto no lo ve
    const m = (await B('check_inbox')).data.messages;
    await B('acknowledge_messages', { messageIds: m.map((x: { id: string }) => x.id) });
  });

  it('idempotencia, validaciones y caducidad', async () => {
    const a = await A('message_peer', { peer: 'beto/b', message: 'una vez', idempotencyKey: 'k1' });
    const b2 = await A('message_peer', { peer: 'beto/b', message: 'una vez', idempotencyKey: 'k1' });
    assert.equal(a.data.messageId, b2.data.messageId);
    assert.equal(b2.data.duplicate, true);
    assert.equal((await B('check_inbox')).data.count, 1);
    assert.equal((await A('message_peer', { peer: 'beto/b', message: 'x', mode: 'response' })).data.code, 'bad_request');
    assert.equal((await A('message_peer', { message: 'sin destino' })).data.code, 'bad_request');
    assert.equal((await A('message_peer', { peer: 'beto/b', message: 'x'.repeat(40_000) })).data.code, 'message_too_large');
    const m = (await B('check_inbox')).data.messages;
    await B('acknowledge_messages', { messageIds: m.map((x: { id: string }) => x.id) });

    await A('message_peer', { peer: 'beto/b', message: 'efímero', expiresInMs: 1000 });
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await B('check_inbox')).data.count, 0);
  });

  it('check_inbox con waitMs despierta en cuanto llega un mensaje', async () => {
    const t0 = Date.now();
    const waiting = B('check_inbox', { waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 150));
    await A('message_peer', { peer: 'beto/b', message: 'despierta' });
    const r = await waiting;
    assert.equal(r.data.messages[0].body, 'despierta');
    assert.ok(Date.now() - t0 < 3000);
    await B('acknowledge_messages', { messageIds: [r.data.messages[0].id] });
    const t1 = Date.now();
    assert.equal((await B('check_inbox', { waitMs: 300 })).data.count, 0);
    assert.ok(Date.now() - t1 >= 250);
  });

  it('canales: suscripción por sesión, hilos, búsqueda y paginación', async () => {
    assert.equal((await A('create_channel', { name: 'general', description: 'todo el equipo' })).ok, true);
    assert.equal((await A('create_channel', { name: 'general' })).data.code, 'channel_exists');
    assert.equal((await A('create_channel', { name: 'Mal Nombre' })).data.code, 'bad_channel_name');
    await B('subscribe_channel', { channelId: 'general', subscribe: true });

    const post = await A('post_channel', { channelId: 'general', body: 'deploy listo en Proyecto B' });
    assert.equal(post.data.notified, 1);
    assert.equal((await A('check_inbox')).data.count, 0); // quien publica no se avisa a sí mismo
    const note = (await B('check_inbox')).data.messages[0];
    assert.equal(note.kind, 'channel');
    assert.match(note.body, /\[#general\] deploy listo/);
    await B('acknowledge_messages', { messageIds: [note.id] });

    const reply = await B('post_channel', { channelId: 'general', body: 'visto', threadId: post.data.postId });
    assert.equal(reply.data.threadId, post.data.postId);
    for (let i = 0; i < 4; i++) await A('post_channel', { channelId: 'general', body: `relleno ${i}` });

    const page1 = (await A('read_channel', { channelId: 'general', limit: 3 })).data;
    assert.equal(page1.posts.length, 3);
    assert.ok(page1.nextCursor);
    const page2 = (await A('read_channel', { channelId: 'general', limit: 10, before: page1.nextCursor })).data;
    assert.ok(page2.posts.length >= 1);
    assert.equal((await A('read_channel', { threadId: post.data.postId })).data.posts.length, 2);
    assert.equal((await A('read_channel', { query: 'deploy' })).data.posts.length, 1);
    assert.equal((await A('read_channel', { query: '100%' })).data.posts.length, 0); // % no es comodín
    assert.equal((await A('list_channels')).data.channels[0].subscribed, false);
    assert.equal((await B('list_channels')).data.channels[0].subscribed, true);
    await B('subscribe_channel', { channelId: 'general', subscribe: false });
    assert.equal((await A('post_channel', { channelId: 'general', body: 'nadie escucha' })).data.notified, 0);
    assert.equal((await A('post_channel', { channelId: 'nada', body: 'x' })).data.code, 'unknown_channel');
  });

  it('tareas: dependencias, reclamar, liberar, completar y permisos', async () => {
    const t1 = (await A('add_task', { title: 'Migración' })).data;
    const t2 = (await A('add_task', { title: 'Despliegue', dependencies: [t1.id] })).data;
    assert.equal(t2.ready, false);
    assert.equal((await A('add_task', { title: 'x', dependencies: ['tsk_no'] })).data.code, 'unknown_task');
    assert.deepEqual((await B('list_tasks', { ready: true })).data.tasks.map((t: { id: string }) => t.id), [t1.id]);
    assert.equal((await B('claim_task', { taskId: t2.id })).data.code, 'task_not_ready');
    assert.equal((await B('claim_task', { taskId: t1.id })).data.claimedBy, 'beto/b');
    assert.equal((await A('claim_task', { taskId: t1.id })).data.code, 'task_not_open');
    assert.equal((await A('complete_task', { taskId: t1.id })).data.code, 'not_claimant');
    assert.equal((await A('release_task', { taskId: t1.id })).data.code, 'not_claimant');
    await B('add_task_progress', { taskId: t1.id, note: 'a medias' });
    assert.equal((await A('add_task_progress', { taskId: t1.id, note: 'intruso' })).data.code, 'not_claimant');
    assert.equal((await B('list_task_progress', { taskId: t1.id })).data.progress.length, 1);
    assert.equal((await B('complete_task', { taskId: t1.id, result: 'hecho' })).data.state, 'done');
    assert.equal((await A('claim_task', { taskId: t2.id })).data.claimedBy, 'ana/a');
    assert.equal((await A('release_task', { taskId: t2.id })).data.state, 'open');
  });

  it('adjuntos: texto, binario, límite y URI', async () => {
    const txt = (await A('upload_attachment', { name: 'nota.md', mediaType: 'text/markdown', dataBase64: Buffer.from('# hola\n').toString('base64') })).data;
    assert.match(txt.uri, /^intercom:\/\/attachments\/att_/);
    const back = (await B('read_attachment', { attachmentId: txt.uri })).data;
    assert.equal(back.text, '# hola\n');
    const bin = Buffer.from([0, 1, 2, 255, 254]);
    const up = (await A('upload_attachment', { name: '../../etc/x.bin', dataBase64: bin.toString('base64') })).data;
    assert.equal(up.name, '.._.._etc_x.bin');
    assert.deepEqual(Buffer.from((await B('read_attachment', { attachmentId: up.id })).data.dataBase64, 'base64'), bin);
    assert.equal((await A('upload_attachment', { name: 'grande', dataBase64: Buffer.alloc(600 * 1024).toString('base64') })).data.code, 'attachment_too_large');
    assert.equal((await A('upload_attachment', { name: 'vacio', dataBase64: '' })).data.code, 'bad_request');
    assert.equal((await B('read_attachment', { attachmentId: 'att_no' })).data.code, 'unknown_attachment');
    assert.ok((await A('list_attachments')).data.attachments.length >= 2);
  });
});
