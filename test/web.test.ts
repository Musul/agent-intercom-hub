import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createInvite } from '../src/invites.ts';
import { boot, j, tool, type Booted } from './helpers.ts';

describe('panel web e invitaciones', () => {
  let b: Booted;
  let ka: string;
  let kb: string;
  let kc: string;
  const A = (name: string, args: Record<string, unknown> = {}, s = 'api') => tool(b.base, ka, s, name, args);
  const B = (name: string, args: Record<string, unknown> = {}, s = 'web') => tool(b.base, kb, s, name, args);
  const C = (name: string, args: Record<string, unknown> = {}, s = 'docs') => tool(b.base, kc, s, name, args);

  /** Un navegador mínimo: guarda la cookie y manda JSON. */
  const browser = () => {
    let cookie = '';
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${b.base}/web/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return { status: res.status, body: await j(res), setCookie: set };
    };
    return { call, get cookie() { return cookie; } };
  };

  before(async () => {
    b = await boot({ ratePerMinute: 10_000, loopMaxExchanges: 1 });
    ka = b.agent('ana', 'Ana');
    kb = b.agent('beto', 'Beto');
    kc = b.agent('caro', 'Caro');
    await A('get_node_status');
    await B('get_node_status');
    await C('get_node_status');
  });
  after(() => b.close());

  it('sirve la página con CSP estricta y sin la llave no da datos', async () => {
    const page = await fetch(`${b.base}/web/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(await page.text(), /Agent Intercom/);
    assert.equal((await fetch(`${b.base}/web/app.js`)).status, 200);
    assert.equal((await fetch(`${b.base}/web/api/state`)).status, 401);
    assert.equal((await fetch(`${b.base}/web/../src/http.ts`)).status, 404);
  });

  it('entrar con la llave: mala → 401; buena → cookie HttpOnly y estado; anti-CSRF', async () => {
    const br = browser();
    assert.equal((await br.call('login', { key: 'aik_falsa_falsa_falsa' })).status, 401);
    const ok = await br.call('login', { key: ka });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie ?? '', /HttpOnly/);
    assert.match(ok.setCookie ?? '', /SameSite=Strict/);
    const st = await br.call('state');
    assert.equal(st.body.result.me.id, 'ana');
    assert.ok(st.body.result.sessions.some((s: { id: string; mine: boolean }) => s.id === 'ana/api' && s.mine));
    // POST sin JSON o desde otro origen
    const raw = await fetch(`${b.base}/web/api/logout`, { method: 'POST', headers: { Cookie: br.cookie, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(raw.status, 415);
    assert.equal((await br.call('logout', {}, { Origin: 'https://malo.example' })).status, 403);
    // Salir invalida la sesión
    assert.equal((await br.call('logout', {})).status, 200);
    assert.equal((await br.call('state')).status, 401);
  });

  it('visibilidad own: ve sus conversaciones, no las ajenas', async () => {
    await A('message_peer', { peer: 'beto/web', message: 'hola beto' });
    await B('message_peer', { peer: 'caro/docs', message: 'secreto entre beto y caro' });
    const br = browser();
    await br.call('login', { key: ka });
    const st = (await br.call('state')).body.result;
    assert.equal(st.conversations.length, 1);
    const conv = st.conversations[0];
    const detail = await br.call(`conversation?a=${conv.a.sessionId}&b=${conv.b.sessionId}`);
    assert.equal(detail.body.result.messages[0].body, 'hola beto');
    const bs = st.sessions.find((s: { id: string }) => s.id === 'beto/web').sessionId;
    const cs = st.sessions.find((s: { id: string }) => s.id === 'caro/docs').sessionId;
    assert.equal((await br.call(`conversation?a=${bs}&b=${cs}`)).status, 403);
    assert.equal((await br.call(`inbox?session=${bs}`)).status, 403);
    const own = st.sessions.find((s: { id: string }) => s.id === 'ana/api').sessionId;
    assert.equal((await br.call(`inbox?session=${own}`)).status, 200);
  });

  it('contestar ask_user desde el panel: llega al buzón de la sesión que preguntó; la de otra persona, no', async () => {
    const q = await A('ask_user', { question: '¿Despliego hoy?', options: ['sí', 'no'] });
    const qb = await A('ask_user', { question: '¿Revisas mi PR?', person: 'beto' });
    const br = browser();
    await br.call('login', { key: ka });
    const st = (await br.call('state')).body.result;
    assert.ok(st.questions.some((x: { id: string }) => x.id === q.data.requestId));
    assert.ok(!st.questions.some((x: { id: string }) => x.id === qb.data.requestId), 'la pregunta a beto no es para ana');
    assert.equal((await br.call('answer', { id: qb.data.requestId, answer: 'sí' })).status, 403);
    assert.equal((await br.call('answer', { id: q.data.requestId, answer: 'sí' })).status, 200);
    const inbox = await A('check_inbox');
    const human = inbox.data.messages.find((m: { kind: string }) => m.kind === 'human');
    assert.equal(human.body, 'sí');
    assert.equal(human.from, 'human:ana');
    const bb = browser();
    await bb.call('login', { key: kb });
    assert.ok((await bb.call('state')).body.result.questions.some((x: { id: string }) => x.id === qb.data.requestId));
  });

  it('política desde el panel: solo en sesiones propias', async () => {
    const br = browser();
    await br.call('login', { key: ka });
    const st = (await br.call('state')).body.result;
    const own = st.sessions.find((s: { id: string }) => s.id === 'ana/api');
    const other = st.sessions.find((s: { id: string }) => s.id === 'beto/web');
    assert.equal(own.inboundPolicy.inbound, 'auto');
    assert.equal(other.inboundPolicy, undefined, 'no ve el detalle de la política ajena');
    const set = await br.call('policy', { sessionId: own.sessionId, inbound: 'hold', allowFrom: ['beto'], wakePerHour: 5 });
    assert.equal(set.status, 200);
    assert.equal(set.body.result.inbound, 'hold');
    assert.equal(set.body.result.wakePerHour, 5);
    assert.equal((await br.call('policy', { sessionId: other.sessionId, inbound: 'off' })).status, 403);
    await br.call('policy', { sessionId: own.sessionId, inbound: 'auto', allowFrom: [], wakePerHour: null });
  });

  it('freno de bucles: la pausa aparece en el panel y «Reanudar» la levanta', async () => {
    await A('message_peer', { peer: 'caro/docs', message: '1' });
    await C('message_peer', { peer: 'ana/api', message: '2' });
    const third = await A('message_peer', { peer: 'caro/docs', message: '3' });
    assert.equal(third.data.heldReason, 'freno_de_bucle');
    const br = browser();
    await br.call('login', { key: ka });
    const st = (await br.call('state')).body.result;
    assert.equal(st.paused.length, 1);
    const p = st.paused[0];
    assert.equal((await br.call('resume', { a: p.sessionA, b: p.sessionB })).body.result.resumed, true);
    assert.equal((await br.call('state')).body.result.paused.length, 0);
    assert.equal((await A('message_peer', { peer: 'caro/docs', message: '4' })).data.wakes, true);
  });

  it('dashboard_link: enlace de un solo uso que abre sesión en el panel', async () => {
    const l = await A('dashboard_link');
    assert.match(l.data.url, /\/web\/#link=iwl_/);
    const token = l.data.url.split('#link=')[1];
    const br = browser();
    assert.equal((await br.call('link', { token })).status, 200);
    assert.equal((await br.call('state')).body.result.me.id, 'ana');
    assert.equal((await browser().call('link', { token })).status, 401, 'no sirve dos veces');
  });

  it('invitación: se canjea UNA vez por una llave que funciona; caducada o repetida → 401', async () => {
    const inv = createInvite(b.hub, 'beto', { label: 'portatil', origin: 'https://intercom.example.com' });
    assert.equal(inv.url, `https://intercom.example.com/join#${inv.token}`);
    const join = (token: string) => fetch(`${b.base}/v1/join`, { method: 'POST', body: JSON.stringify({ token }) });
    const r = await join(inv.token);
    assert.equal(r.status, 200);
    const body = await j(r);
    assert.equal(body.result.agentId, 'beto');
    assert.match(body.result.key, /^aik_/);
    assert.equal((await tool(b.base, body.result.key, 'nueva', 'get_node_status')).data.identity.address, 'beto/nueva');
    assert.equal((await join(inv.token)).status, 401);
    const old = createInvite(b.hub, 'beto', { hours: 1 });
    b.hub.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1, old.inviteId);
    assert.equal((await join(old.token)).status, 401);
    assert.equal((await fetch(`${b.base}/join`)).status, 200);
  });
});
