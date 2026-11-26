import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { boot, tool, type Booted } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un cliente MCP con estado mínimo: initialize → Mcp-Session-Id, peticiones con esa cabecera y stream GET. */
class Chat {
  sid = '';
  instructions = '';
  events: Array<Record<string, unknown>> = [];
  private stream?: http.ClientRequest;
  private seq = 0;
  private base: string;
  private key: string;
  private headers: Record<string, string>;
  private client: { name: string; capabilities?: Record<string, unknown> };
  constructor(base: string, key: string, headers: Record<string, string> = {}, client: { name: string; capabilities?: Record<string, unknown> } = { name: 'claude-code' }) {
    this.base = base;
    this.key = key;
    this.headers = headers;
    this.client = client;
  }

  private h(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.sid ? { 'Mcp-Session-Id': this.sid } : {}),
      ...this.headers,
    };
  }

  async post(msg: Record<string, unknown>): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(`${this.base}/mcp`, { method: 'POST', headers: this.h(), body: JSON.stringify({ jsonrpc: '2.0', ...msg }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  async init(): Promise<this> {
    const r = await this.post({ id: ++this.seq, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: this.client.capabilities ?? {}, clientInfo: { name: this.client.name, version: '9.9' } } });
    assert.equal(r.status, 200);
    this.sid = r.headers.get('mcp-session-id') ?? '';
    assert.match(this.sid, /^con_[0-9a-f]{24}$/);
    this.instructions = r.body.result.instructions;
    await this.post({ method: 'notifications/initialized' });
    return this;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: any }> {
    const r = await this.post({ id: ++this.seq, method: 'tools/call', params: { name, arguments: args } });
    if (r.body.error) return { ok: false, data: r.body.error };
    return { ok: !r.body.result.isError, data: r.body.result.isError ? r.body.result.structuredContent.error : r.body.result.structuredContent };
  }

  /** Abre el stream GET y va guardando los eventos JSON-RPC que llegan. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.base}/mcp`, { method: 'GET', headers: { ...this.h(), Accept: 'text/event-stream' } }, (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (data) this.events.push(JSON.parse(data.slice(6)));
          }
        });
        resolve();
      });
      req.on('error', reject);
      req.end();
      this.stream = req;
    });
  }

  closeStream(): void {
    this.stream?.destroy();
  }

  async waitFor(pred: (e: Record<string, unknown>) => boolean, ms = 3000): Promise<Record<string, unknown>> {
    for (let t = 0; t < ms; t += 25) {
      const e = this.events.find(pred);
      if (e) return e;
      await sleep(25);
    }
    throw new Error(`no llegó el evento esperado; llegaron: ${JSON.stringify(this.events).slice(0, 500)}`);
  }

  async del(): Promise<number> {
    const res = await fetch(`${this.base}/mcp`, { method: 'DELETE', headers: this.h() });
    return res.status;
  }
}

describe('chats con estado: nombre elegido por el usuario, entrega automática y presencia', () => {
  let b: Booted;
  let ana: string;
  let beto: string;
  const peerOf = async (key: string, id: string) => (await tool(b.base, key, 'obs', 'list_peers', { query: id.split('/')[1] })).data.peers.find((p: { id: string }) => p.id === id);

  before(async () => {
    b = await boot({ ratePerMinute: 100_000, recentMs: 60_000, pushConfirmMs: 400 });
    ana = b.agent('ana', 'Ana Torres');
    beto = b.agent('beto', 'Beto');
  });
  after(() => b.close());

  it('un chat nuevo nace sin nombre: solo puede nombrarse, y register_session lo nombra', async () => {
    const c = await new Chat(b.base, ana, { 'X-Session-Cwd': '/home/ana/Proyecto Salud' }).init();
    assert.match(c.instructions, /no tiene NOMBRE DE SESIÓN/);
    assert.match(c.instructions, /proyecto-salud/);
    const st = await c.call('get_node_status');
    assert.equal(st.data.identity.named, false);
    assert.equal(st.data.identity.suggestedName, 'proyecto-salud');
    const blocked = await c.call('message_peer', { peer: 'beto', message: 'hola' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.data.code, 'session_unnamed');

    const bad = await c.call('register_session', { name: '***' });
    assert.equal(bad.data.code, 'bad_session_name');
    const r = await c.call('register_session', { name: 'Salud API', description: 'API de salud' });
    assert.equal(r.ok, true);
    assert.equal(r.data.address, 'ana/salud-api');
    const st2 = await c.call('get_node_status');
    assert.equal(st2.data.identity.address, 'ana/salud-api');
    assert.equal(st2.data.session.description, 'API de salud');
    assert.equal(st2.data.session.cwd, '/home/ana/Proyecto Salud');
    await c.del();
  });

  it('con X-Session-Name nace nombrado (compatibilidad) y X-Session-Instance recupera el nombre del mismo chat', async () => {
    const fixed = await new Chat(b.base, ana, { 'X-Session-Name': 'fija' }).init();
    assert.equal((await fixed.call('get_node_status')).data.identity.address, 'ana/fija');

    const a = await new Chat(b.base, ana, { 'X-Session-Instance': 'chat-123' }).init();
    await a.call('register_session', { name: 'reconecta' });
    const again = await new Chat(b.base, ana, { 'X-Session-Instance': 'chat-123' }).init();
    assert.match(again.instructions, /Conectado como ana\/reconecta/);
    // la conexión vieja del mismo chat quedó cerrada
    assert.equal((await a.post({ id: 99, method: 'ping' })).status, 404);
    await fixed.del();
    await again.del();
  });

  it('un nombre abierto en otro chat da session_in_use; takeover lo permite; DELETE lo libera', async () => {
    const uno = await new Chat(b.base, beto).init();
    await uno.call('register_session', { name: 'compartida' });
    await uno.open();
    const dos = await new Chat(b.base, beto).init();
    const busy = await dos.call('register_session', { name: 'compartida' });
    assert.equal(busy.data.code, 'session_in_use');
    const forced = await dos.call('register_session', { name: 'compartida', takeover: true });
    assert.equal(forced.ok, true);
    await dos.del();
    uno.closeStream();
    assert.equal(await uno.del(), 204);
    const tres = await new Chat(b.base, beto).init();
    assert.equal((await tres.call('register_session', { name: 'compartida' })).ok, true);
    await tres.del();
  });

  it('formulario MCP: el servidor pide el nombre por el stream y la respuesta del usuario nombra el chat', async () => {
    const c = new Chat(b.base, ana, { 'X-Session-Suggest': 'Mi Repo' }, { name: 'claude-code', capabilities: { elicitation: { form: {} } } });
    await c.init();
    await c.open();
    const ask = await c.waitFor((e) => e.method === 'elicitation/create');
    const params = ask.params as { requestedSchema: { properties: { name: { default?: string } } } };
    assert.equal(params.requestedSchema.properties.name.default, 'mi-repo');
    // primer intento con un nombre ocupado → lo vuelve a pedir con el motivo
    const otro = await new Chat(b.base, ana).init();
    await otro.call('register_session', { name: 'ocupada' });
    await otro.open();
    const r1 = await c.post({ id: ask.id, result: { action: 'accept', content: { name: 'ocupada' } } });
    assert.equal(r1.status, 202);
    const ask2 = await c.waitFor((e) => e.method === 'elicitation/create' && e.id !== ask.id);
    assert.match(String((ask2.params as { message: string }).message), /ya está abierta/);
    await c.post({ id: ask2.id, result: { action: 'accept', content: { name: 'Desde Formulario', description: 'nombrada por el usuario' } } });
    for (let i = 0; i < 40 && !(await c.call('get_node_status')).data.identity.named; i++) await sleep(25);
    const st = await c.call('get_node_status');
    assert.equal(st.data.identity.address, 'ana/desde-formulario');
    assert.equal(st.data.session.description, 'nombrada por el usuario');
    otro.closeStream();
    c.closeStream();
    await otro.del();
    await c.del();
  });

  it('si el usuario cierra el formulario no se vuelve a pedir: el agente lo pregunta en el chat', async () => {
    const c = new Chat(b.base, ana, {}, { name: 'claude-code', capabilities: { elicitation: {} } });
    await c.init();
    await c.open();
    const ask = await c.waitFor((e) => e.method === 'elicitation/create');
    await c.post({ id: ask.id, result: { action: 'cancel' } });
    await sleep(50);
    c.closeStream();
    await c.open(); // reconecta el stream: no se insiste
    await sleep(150);
    assert.equal(c.events.filter((e) => e.method === 'elicitation/create').length, 1);
    assert.equal((await c.call('get_node_status')).data.connection.naming, 'declined');
    c.closeStream();
    await c.del();
  });

  it('Claude Code recibe cada mensaje por canal (también lo que esperaba), una sola vez; sin confirmar pasa a offline', async () => {
    const tx = await new Chat(b.base, beto).init();
    await tx.call('register_session', { name: 'emisor' });
    const rx = await new Chat(b.base, ana).init();
    await rx.call('register_session', { name: 'canal' });
    const early = await tx.call('message_peer', { peer: 'ana/canal', message: 'primero' });
    assert.equal(early.ok, true);
    assert.equal((await peerOf(beto, 'ana/canal')).offlineReason, 'sin_entrega_automatica'); // chat abierto, sin stream aún

    await rx.open();
    const first = await rx.waitFor((e) => e.method === 'notifications/claude/channel');
    const fp = first.params as { content: string; meta: Record<string, string> };
    assert.match(fp.content, /primero/);
    assert.match(fp.content, /no instrucciones/);
    assert.equal(fp.meta.from, 'beto/emisor');
    assert.equal(fp.meta.message_id, early.data.messageId);
    assert.equal((await peerOf(beto, 'ana/canal')).presence, 'online');

    const live = await tx.call('message_peer', { peer: 'ana/canal', message: 'en vivo', mode: 'request' });
    await rx.waitFor((e) => e.method === 'notifications/claude/channel' && (e.params as { meta: { message_id: string } }).meta.message_id === live.data.messageId);

    // reconectar el stream no duplica lo ya entregado a este chat
    rx.closeStream();
    const before = rx.events.length;
    await rx.open();
    await sleep(150);
    assert.equal(rx.events.slice(before).filter((e) => e.method === 'notifications/claude/channel').length, 0);

    // sin confirmar en pushConfirmMs (400 ms en esta prueba) → offline «sin_confirmar»
    await sleep(500);
    let p = await peerOf(beto, 'ana/canal');
    assert.deepEqual([p.presence, p.offlineReason], ['offline', 'sin_confirmar']);
    await rx.call('acknowledge_messages', { messageIds: [early.data.messageId, live.data.messageId] });
    p = await peerOf(beto, 'ana/canal');
    assert.equal(p.presence, 'online');

    // cerrar el chat (DELETE) → offline «cerrada»
    assert.equal(await rx.del(), 204);
    await sleep(50);
    p = await peerOf(beto, 'ana/canal');
    assert.deepEqual([p.presence, p.offlineReason], ['offline', 'cerrada']);
    await tx.del();
  });

  it('un cliente sin canal (Codex, OpenCode…) o Claude Code sin canal activo queda offline: sin_entrega_automatica', async () => {
    const codex = new Chat(b.base, beto, {}, { name: 'codex-mcp-client' });
    await codex.init();
    await codex.call('register_session', { name: 'codex' });
    await codex.open();
    let p = await peerOf(ana, 'beto/codex');
    assert.deepEqual([p.presence, p.offlineReason, p.connected], ['offline', 'sin_entrega_automatica', true]);
    codex.closeStream();
    await codex.del();

    const sinCanal = new Chat(b.base, beto, { 'X-Intercom-Channels': '0' });
    await sinCanal.init();
    await sinCanal.call('register_session', { name: 'sin-canal' });
    await sinCanal.open();
    p = await peerOf(ana, 'beto/sin-canal');
    assert.equal(p.offlineReason, 'sin_entrega_automatica');
    sinCanal.closeStream();
    await sinCanal.del();
  });

  it('Mcp-Session-Id ajeno o inventado → 404 (hay que reinicializar)', async () => {
    const c = await new Chat(b.base, ana).init();
    const other = new Chat(b.base, beto);
    other.sid = c.sid;
    assert.equal((await other.post({ id: 1, method: 'tools/list' })).status, 404);
    other.sid = 'con_000000000000000000000000';
    assert.equal((await other.post({ id: 1, method: 'tools/list' })).status, 404);
    await c.del();
  });
});
