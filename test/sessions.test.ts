import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { answerQuestion } from '../src/files.ts';
import { auth, boot, tool, type Booted } from './helpers.ts';

describe('sesiones con nombre: varias por clave, cada una con su buzón', () => {
  let b: Booted;
  let ana: string;
  let admin: string;
  const T = (key: string, s: string | undefined, name: string, args: Record<string, unknown> = {}) => tool(b.base, key, s, name, args);

  before(async () => {
    b = await boot({ ratePerMinute: 10_000, recentMs: 60_000 });
    ana = b.agent('ana', 'Ana Torres');
    admin = b.agent('admin', 'Operador');
    await T(ana, 'proyecto-a', 'set_session_info', { description: 'proyecto-a v2: módulo de salud de Ana', tags: ['proyecto-a', 'salud'], harness: 'claude-code', lifecycle: 'busy' });
    await T(ana, 'proyecto-b', 'set_session_info', { description: 'Despliegue y operación de Proyecto B', tags: ['proyecto-b', 'deploy'] });
    await T(admin, 'demo', 'set_session_info', { description: 'Modo demo para Cliente Demo' });
  });
  after(() => b.close());

  it('la misma clave con dos nombres son dos sesiones distintas', async () => {
    const r = await T(admin, 'demo', 'list_peers');
    const ids = r.data.peers.map((p: { id: string }) => p.id).sort();
    assert.deepEqual(ids, ['admin/demo', 'ana/proyecto-a', 'ana/proyecto-b']);
    assert.equal(r.data.peers.find((p: { self: boolean }) => p.self).id, 'admin/demo');
    const h = r.data.peers.find((p: { id: string }) => p.id === 'ana/proyecto-a');
    assert.equal(h.displayName, 'Ana Torres');
    assert.equal(h.lifecycle, 'busy');
    assert.deepEqual(h.tags, ['proyecto-a', 'salud']);
  });

  it('«pregúntale a la sesión del proyecto-a de Ana»: la búsqueda por palabras la encuentra', async () => {
    const r = await T(admin, 'demo', 'list_peers', { query: 'proyecto-a de ana' });
    assert.equal(r.data.match, 'all');
    assert.deepEqual(r.data.peers.map((p: { id: string }) => p.id), ['ana/proyecto-a']);
    const parcial = await T(admin, 'demo', 'list_peers', { query: 'proyecto-b admin' });
    assert.equal(parcial.data.match, 'partial');
    assert.ok(parcial.data.peers.length >= 1);
    const acentos = await T(admin, 'demo', 'list_peers', { query: 'SALÚD' });
    assert.equal(acentos.data.peers[0].id, 'ana/proyecto-a');
  });

  it('un mensaje a una sesión NO llega a las otras sesiones de la misma clave', async () => {
    const sent = await T(admin, 'demo', 'message_peer', { peer: 'ana/proyecto-a', message: '¿cómo va el módulo?', mode: 'request' });
    assert.equal(sent.ok, true);
    assert.equal(sent.data.to, 'ana/proyecto-a');
    assert.equal((await T(ana, 'proyecto-b', 'check_inbox')).data.count, 0);
    const inbox = await T(ana, 'proyecto-a', 'check_inbox');
    assert.equal(inbox.data.count, 1);
    assert.equal(inbox.data.messages[0].from, 'admin/demo');
    assert.equal(inbox.data.messages[0].to, 'ana/proyecto-a');
    await T(ana, 'proyecto-a', 'acknowledge_messages', { messageIds: [inbox.data.messages[0].id] });
  });

  it('solo el agente, con varias sesiones: ambiguous_peer con candidatas; nunca adivina', async () => {
    const r = await T(admin, 'demo', 'message_peer', { peer: 'ana', message: 'hola' });
    assert.equal(r.ok, false);
    assert.equal(r.data.code, 'ambiguous_peer');
    assert.deepEqual(r.data.candidates.map((c: { id: string }) => c.id), ['ana/proyecto-a', 'ana/proyecto-b']);
    assert.equal((await T(ana, 'proyecto-a', 'check_inbox')).data.count, 0);
  });

  it('el nombre visible único también vale; sesión inexistente da candidatas', async () => {
    const r = await T(admin, 'demo', 'message_peer', { peer: 'ana/nada', message: 'hola' });
    assert.equal(r.data.code, 'unknown_peer');
    assert.equal(r.data.candidates.length, 2);
    const single = await T(ana, 'proyecto-a', 'message_peer', { peer: 'Operador', message: 'recibido' });
    assert.equal(single.ok, true);
    assert.equal(single.data.to, 'admin/demo');
    const id = (await T(admin, 'demo', 'check_inbox')).data.messages[0].id;
    await T(admin, 'demo', 'acknowledge_messages', { messageIds: [id] });
  });

  it('agente/*: difunde a todas sus sesiones (menos la propia)', async () => {
    const r = await T(admin, 'demo', 'message_peer', { peer: 'ana/*', message: 'aviso general' });
    assert.equal(r.data.count, 2);
    assert.equal((await T(ana, 'proyecto-a', 'check_inbox')).data.count, 1);
    assert.equal((await T(ana, 'proyecto-b', 'check_inbox')).data.count, 1);
    for (const s of ['proyecto-a', 'proyecto-b']) {
      const m = (await T(ana, s, 'check_inbox')).data.messages;
      await T(ana, s, 'acknowledge_messages', { messageIds: m.map((x: { id: string }) => x.id) });
    }
  });

  it('no puedes escribirte a ti mismo; por id de sesión también se puede', async () => {
    assert.equal((await T(admin, 'demo', 'message_peer', { peer: 'admin/demo', message: 'yo' })).data.code, 'cannot_message_self');
    const list = await T(admin, 'demo', 'list_peers', { agent: 'ana' });
    const sid = list.data.peers.find((p: { session: string }) => p.session === 'proyecto-b').sessionId;
    const r = await T(admin, 'demo', 'message_peer', { peer: sid, message: 'por id' });
    assert.equal(r.data.to, 'ana/proyecto-b');
    const m = (await T(ana, 'proyecto-b', 'check_inbox')).data.messages;
    await T(ana, 'proyecto-b', 'acknowledge_messages', { messageIds: m.map((x: { id: string }) => x.id) });
  });

  it('sesión sin nombre: avisa en get_node_status', async () => {
    const st = await T(admin, undefined, 'get_node_status');
    assert.equal(st.data.identity.sessionName, 'default');
    assert.equal(st.data.warnings.length, 1);
  });

  it('presencia: online con un oyente que recibe en automático, offline (cerrada) al cerrarlo', async () => {
    const open = (extra: Record<string, string>) =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(`${b.base}/mcp`, { method: 'GET', headers: { ...auth(ana, 'proyecto-a'), Accept: 'text/event-stream', ...extra } }, resolve);
        req.on('error', reject);
        req.end();
      });
    const peer = async () => (await T(admin, 'demo', 'list_peers', { agent: 'ana' })).data.peers.find((p: { session: string }) => p.session === 'proyecto-a');
    const presence = async () => (await peer()).presence;

    // un stream que nadie lee en automático: chat abierto, pero offline
    const mudo = await open({});
    let p = await peer();
    assert.deepEqual([p.presence, p.offlineReason, p.connected], ['offline', 'sin_entrega_automatica', true]);
    mudo.destroy();
    await new Promise((r) => setTimeout(r, 100));

    const stream = await open({ 'X-Intercom-Listener': '1' });
    assert.equal(stream.statusCode, 200);
    assert.match(String(stream.headers['content-type']), /event-stream/);
    assert.equal(await presence(), 'online');

    // un mensaje nuevo se avisa por el propio stream
    let seen = '';
    stream.on('data', (c: Buffer) => (seen += c.toString()));
    await T(admin, 'demo', 'message_peer', { peer: 'ana/proyecto-a', message: 'ping por SSE' });
    for (let i = 0; i < 40 && !seen.includes('"event":"inbox"'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(seen, /"event":"inbox"/);

    stream.destroy();
    await new Promise((r) => setTimeout(r, 100));
    p = await peer();
    assert.deepEqual([p.presence, p.offlineReason], ['offline', 'cerrada']);
    const m = (await T(ana, 'proyecto-a', 'check_inbox')).data.messages;
    await T(ana, 'proyecto-a', 'acknowledge_messages', { messageIds: m.map((x: { id: string }) => x.id) });
  });

  it('ask_user: la respuesta de una persona llega al buzón de la sesión que preguntó', async () => {
    const q = await T(ana, 'proyecto-b', 'ask_user', { question: '¿Despliego hoy?', options: ['sí', 'no'] });
    assert.equal(q.ok, true);
    answerQuestion(b.hub, q.data.requestId, 'sí, hoy', 'ana');
    const inbox = await T(ana, 'proyecto-b', 'check_inbox');
    assert.equal(inbox.data.messages[0].from, 'human:ana');
    assert.equal(inbox.data.messages[0].body, 'sí, hoy');
    assert.equal((await T(ana, 'proyecto-a', 'check_inbox')).data.count, 0);
    // a un mensaje de una persona no se puede «responder» como a una sesión
    const r = await T(ana, 'proyecto-b', 'message_peer', { message: 'gracias', responseTo: inbox.data.messages[0].id });
    assert.equal(r.data.code, 'no_reply_target');
  });
});
