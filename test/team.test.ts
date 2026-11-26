import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { boot, j, tool, type Booted } from './helpers.ts';

/** Equipo con seats separados: política de entrada, freno de bucles, nombre automático, reparto de tareas. */
describe('equipo: política de entrada, freno de bucles, nombre automático y reparto de tareas', () => {
  let b: Booted;
  let ka: string;
  let kb: string;
  let kc: string;
  const A = (name: string, args: Record<string, unknown> = {}, s = 'api') => tool(b.base, ka, s, name, args);
  const B = (name: string, args: Record<string, unknown> = {}, s = 'web') => tool(b.base, kb, s, name, args);
  const C = (name: string, args: Record<string, unknown> = {}, s = 'docs') => tool(b.base, kc, s, name, args);
  const humanTurn = async (key: string, session: string) => {
    const r = await fetch(`${b.base}/v1/human-turn`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Session-Name': session } });
    return { status: r.status, body: await j(r) };
  };

  before(async () => {
    b = await boot({ ratePerMinute: 10_000, loopMaxExchanges: 2, wakePerHour: 30 });
    ka = b.agent('ana');
    kb = b.agent('beto');
    kc = b.agent('caro');
    await A('get_node_status');
    await B('get_node_status');
    await C('get_node_status');
  });
  after(() => b.close());

  it('hold: el mensaje queda en el buzón sin despertar, el remitente lo sabe y el turno humano lo entrega', async () => {
    const set = await B('set_inbound_policy', { inbound: 'hold' });
    assert.equal(set.data.inboundPolicy.inbound, 'hold');
    const sent = await A('message_peer', { peer: 'beto/web', message: '¿tienes el contrato del endpoint?' });
    assert.equal(sent.data.wakes, false);
    assert.equal(sent.data.heldReason, 'retenido_por_politica');
    assert.match(sent.data.note, /hold/);
    // Nadie lo empujó: no tiene pushed_at aunque hubiera un oyente
    const row = b.hub.db.prepare('SELECT wake, pushed_at FROM messages WHERE id = ?').get(sent.data.messageId) as { wake: number; pushed_at: number | null };
    assert.equal(row.wake, 0);
    assert.equal(row.pushed_at, null);
    // El turno humano lo entrega (para meterlo en el contexto) y queda como entregado
    const ht = await humanTurn(kb, 'web');
    assert.equal(ht.status, 200);
    assert.equal(ht.body.result.count, 1);
    assert.equal(ht.body.result.messages[0].id, sent.data.messageId);
    assert.equal(ht.body.result.messages[0].wake, false);
    // al menos una vez: mientras no se confirme vuelve a salir (marcado redelivered); el cliente descarta los que ya metió
    const again = (await humanTurn(kb, 'web')).body.result;
    assert.equal(again.count, 1);
    assert.equal(again.messages[0].redelivered, true);
    const inbox = await B('check_inbox');
    assert.equal(inbox.data.messages[0].heldReason, 'retenido_por_politica');
    await B('acknowledge_messages', { messageIds: [sent.data.messageId] });
    assert.equal((await humanTurn(kb, 'web')).body.result.count, 0, 'confirmado ya no sale');
    await B('set_inbound_policy', { inbound: 'auto' });
  });

  it('off: rechaza mensajes nuevos, pero acepta la respuesta a lo que esa sesión preguntó', async () => {
    const ask = await C('message_peer', { peer: 'ana/api', message: '¿qué versión de node usáis?', mode: 'request' });
    assert.equal(ask.ok, true);
    await C('set_inbound_policy', { inbound: 'off' });
    const refused = await A('message_peer', { peer: 'caro/docs', message: 'hola' });
    assert.equal(refused.ok, false);
    assert.equal(refused.data.code, 'peer_not_accepting');
    const reply = await A('message_peer', { message: 'node 24', responseTo: ask.data.messageId });
    assert.equal(reply.ok, true);
    assert.equal(reply.data.wakes, true, 'la respuesta a su pregunta sí la despierta');
    // En un envío a «agente/*», la sesión en off se salta en vez de fallar todo
    await C('get_node_status', {}, 'otra');
    const fan = await A('message_peer', { peer: 'caro/*', message: 'aviso general' });
    assert.equal(fan.ok, true);
    assert.deepEqual(fan.data.refused, ['caro/docs']);
    assert.equal(fan.data.count, 1);
    await C('set_inbound_policy', { inbound: 'auto' });
  });

  it('allowFrom: solo despiertan los remitentes permitidos; el resto queda en cola', async () => {
    await A('set_inbound_policy', { allowFrom: ['caro'] });
    const fromB = await B('message_peer', { peer: 'ana/api', message: 'de beto' });
    assert.equal(fromB.data.wakes, false);
    assert.equal(fromB.data.heldReason, 'remitente_no_permitido');
    const fromC = await C('message_peer', { peer: 'ana/api', message: 'de caro' });
    assert.equal(fromC.data.wakes, true);
    const bad = await A('set_inbound_policy', { allowFrom: ['no válido!'] });
    assert.equal(bad.ok, false);
    await A('set_inbound_policy', { allowFrom: [] });
  });

  it('tope por hora: pasado el tope, los mensajes no despiertan', async () => {
    await C('set_inbound_policy', { wakePerHour: 1 }, 'tope');
    const first = await A('message_peer', { peer: 'caro/tope', message: 'uno' }, 'x1');
    const second = await A('message_peer', { peer: 'caro/tope', message: 'dos' }, 'x2');
    assert.equal(first.data.wakes, true);
    assert.equal(second.data.wakes, false);
    assert.equal(second.data.heldReason, 'tope_por_hora');
    const st = await C('get_node_status', {}, 'tope');
    assert.equal(st.data.inboundPolicy.wakePerHour, 1);
    assert.equal(st.data.inboundPolicy.heldPending, 1);
    await C('set_inbound_policy', { wakePerHour: -1 }, 'tope');
    assert.equal((await C('get_node_status', {}, 'tope')).data.inboundPolicy.wakePerHour, 30);
  });

  it('freno de bucles: tras N idas y vueltas sin persona se pausa, avisa a ambos y el turno humano lo reanuda', async () => {
    const P = (from: 'a' | 'b', msg: string) => (from === 'a' ? A('message_peer', { peer: 'beto/loop', message: msg }, 'loop') : B('message_peer', { peer: 'ana/loop', message: msg }, 'loop'));
    await B('get_node_status', {}, 'loop');
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await P(i % 2 ? 'b' : 'a', `ping ${i}`));
    assert.ok(results.every((r) => r.data.wakes === true), 'con 2 idas y vueltas (4 mensajes) todo pasa');
    const fifth = await P('a', 'ping 4');
    assert.equal(fifth.data.wakes, false);
    assert.equal(fifth.data.heldReason, 'freno_de_bucle');
    assert.match(fifth.data.note, /pausada/);
    // Aviso del servidor a ambas sesiones (no despierta)
    const inboxB = await B('check_inbox', {}, 'loop');
    const notice = inboxB.data.messages.find((m: { kind: string }) => m.kind === 'system');
    assert.ok(notice, 'aviso del servidor');
    assert.equal(notice.wake, false);
    assert.equal((await A('get_node_status', {}, 'loop')).data.pausedConversations.length, 1);
    // Sigue pausada hasta que una persona intervenga
    assert.equal((await P('b', 'pong')).data.heldReason, 'freno_de_bucle');
    const ht = await humanTurn(kb, 'loop');
    assert.equal(ht.body.result.resumedConversations, 1);
    assert.equal((await P('a', 'otra vez')).data.wakes, true);
  });

  it('turno humano sin sesión identificada → 409', async () => {
    const r = await humanTurn(ka, '');
    assert.equal(r.status, 409);
  });

  it('nombre automático: la sugerencia del cliente si está libre; si choca, queda sin nombre para preguntar', async () => {
    const init = async (headers: Record<string, string>) => {
      const res = await fetch(`${b.base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ka}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } }),
      });
      const sid = res.headers.get('mcp-session-id')!;
      const st = await fetch(`${b.base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ka}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_node_status', arguments: {} } }),
      });
      return (await j(st)).result.structuredContent;
    };
    const auto = { 'X-Session-Auto': '1', 'X-Session-Suggest': 'sam-api-feat-login', 'X-Session-Tags': 'sam-api, feat-login, ¡mal!' };
    const first = await init(auto);
    assert.equal(first.identity.named, true);
    assert.equal(first.identity.address, 'ana/sam-api-feat-login');
    assert.deepEqual(first.session.tags, ['sam-api', 'feat-login']);
    const second = await init(auto);
    assert.equal(second.identity.named, false, 'el nombre está abierto en otro chat: se pregunta');
    assert.equal(second.identity.suggestedName, 'sam-api-feat-login-2', 'propone uno libre');
    // Sin la cabecera, como antes: sin nombre
    const plain = await init({ 'X-Session-Suggest': 'otra-cosa' });
    assert.equal(plain.identity.named, false);
  });

  it('reparto de tareas: avisa a las sesiones con la etiqueta, al creador al completarla y a las dependientes al quedar listas', async () => {
    await B('set_session_info', { tags: ['pagos'] }, 'pagos');
    await C('set_session_info', { tags: ['otra'] }, 'nada');
    const t1 = await A('add_task', { title: 'Endpoint de cobro', description: 'POST /cobros', tags: ['Pagos'] }, 'coord');
    assert.deepEqual(t1.data.tags, ['pagos']);
    assert.equal(t1.data.notified, 1);
    const t2 = await A('add_task', { title: 'Pruebas de cobro', tags: ['pagos'], dependencies: [t1.data.id] }, 'coord');
    assert.equal(t2.data.notified, 0, 'no está lista: no se anuncia aún');
    const inbox = await B('check_inbox', {}, 'pagos');
    const notice = inbox.data.messages.find((m: { kind: string }) => m.kind === 'task');
    assert.match(notice.body, /Endpoint de cobro/);
    assert.equal((await C('check_inbox', {}, 'nada')).data.count, 0);
    // filtros
    assert.equal((await B('list_tasks', { tag: 'pagos' }, 'pagos')).data.tasks.length, 2);
    await B('claim_task', { taskId: t1.data.id }, 'pagos');
    assert.equal((await B('list_tasks', { mine: true }, 'pagos')).data.tasks.length, 1);
    await B('acknowledge_messages', { messageIds: inbox.data.messages.map((m: { id: string }) => m.id) }, 'pagos');
    await B('complete_task', { taskId: t1.data.id, result: 'hecho en PR 12' }, 'pagos');
    const coord = await A('check_inbox', {}, 'coord');
    assert.ok(coord.data.messages.some((m: { kind: string; body: string }) => m.kind === 'task' && /completada/.test(m.body) && /PR 12/.test(m.body)));
    const again = await B('check_inbox', {}, 'pagos');
    assert.ok(again.data.messages.some((m: { body: string }) => /lista para reclamar/.test(m.body) && /Pruebas de cobro/.test(m.body)));
  });

  it('ask_user a otra persona: queda dirigida a ella; persona inexistente → error', async () => {
    const q = await A('ask_user', { question: '¿Aprobamos el diseño?', options: ['sí', 'no'], person: 'beto' });
    assert.equal(q.data.person, 'beto');
    const bad = await A('ask_user', { question: '¿?', person: 'nadie' });
    assert.equal(bad.data.code, 'unknown_person');
  });
});
