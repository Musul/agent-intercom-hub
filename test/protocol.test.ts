import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addKey, disableAgent, revokeKey } from '../src/admin.ts';
import { auth, boot, j, rpc, tool, type Booted } from './helpers.ts';

describe('HTTP y protocolo MCP', () => {
  let b: Booted;
  let key: string;
  before(async () => {
    b = await boot({ maxBodyBytes: 2048, ratePerMinute: 1000 });
    key = b.agent('admin', 'Operador');
  });
  after(() => b.close());

  it('sin clave o con clave falsa: 401 y Www-Authenticate, sin leer el cuerpo', async () => {
    const r1 = await fetch(`${b.base}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(r1.status, 401);
    assert.match(r1.headers.get('www-authenticate') ?? '', /Bearer/);
    const r2 = await fetch(`${b.base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer aik_falsa' }, body: 'x'.repeat(100_000) });
    assert.equal(r2.status, 401);
  });

  it('cuerpo por encima del tope: 413', async () => {
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(key), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(5000) }) });
    assert.equal(r.status, 413);
  });

  it('un Origin de navegador no permitido se rechaza', async () => {
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: { ...auth(key), Origin: 'https://malo.example' }, body: '{}' });
    assert.equal(r.status, 403);
  });

  it('initialize devuelve versión, capacidades e instrucciones con el nombre de la sesión', async () => {
    const { status, body } = await rpc(b.base, key, 'proyecto-a', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(status, 200);
    assert.equal(body.result.protocolVersion, '2025-06-18');
    assert.ok(body.result.capabilities.tools);
    assert.match(body.result.instructions, /admin\/proyecto-a/);
    const sin = await rpc(b.base, key, undefined, 'initialize', { protocolVersion: '1999-01-01' });
    assert.match(sin.body.result.instructions, /sin nombre/);
    assert.ok(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(sin.body.result.protocolVersion));
  });

  it('tools/list expone las herramientas con su esquema; las notificaciones dan 202', async () => {
    const { body } = await rpc(b.base, key, 's1', 'tools/list');
    const names = body.result.tools.map((t: { name: string }) => t.name);
    for (const n of ['list_peers', 'message_peer', 'check_inbox', 'acknowledge_messages', 'set_session_info', 'get_node_status', 'post_channel', 'claim_task', 'upload_attachment', 'ask_user']) assert.ok(names.includes(n), n);
    assert.equal(body.result.tools.find((t: { name: string }) => t.name === 'message_peer').inputSchema.type, 'object');
    const n = await rpc(b.base, key, 's1', 'notifications/initialized', undefined, null);
    assert.equal(n.status, 202);
  });

  it('método desconocido, herramienta desconocida, argumentos inválidos y lote', async () => {
    assert.equal((await rpc(b.base, key, 's1', 'nada/que/ver')).body.error.code, -32601);
    assert.equal((await rpc(b.base, key, 's1', 'tools/call', { name: 'no_existe' })).body.error.code, -32602);
    const bad = await tool(b.base, key, 's1', 'message_peer', { peer: 'x', message: 'hola', mode: 'gritar' });
    assert.equal(bad.ok, false);
    assert.equal(bad.data.code, 'invalid_arguments');
    const extra = await tool(b.base, key, 's1', 'list_peers', { inventado: 1 });
    assert.equal(extra.data.code, 'invalid_arguments');
    // null = «no puesto» (clientes antiguos)
    assert.equal((await tool(b.base, key, 's1', 'list_peers', { query: null })).ok, true);
    const res = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(key, 's1'), body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]) });
    const arr = await j(res);
    assert.equal(arr.length, 2);
  });

  it('JSON roto: error de parseo JSON-RPC', async () => {
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(key), body: '{no es json' });
    assert.equal(r.status, 400);
    assert.equal((await j(r)).error.code, -32700);
  });

  it('GET sin text/event-stream y DELETE: 405', async () => {
    const soloJson = { ...auth(key), Accept: 'application/json' };
    assert.equal((await fetch(`${b.base}/mcp`, { headers: soloJson })).status, 405);
    assert.equal((await fetch(`${b.base}/mcp`, { method: 'DELETE', headers: soloJson })).status, 405);
  });

  it('espejo REST: GET /v1/tools y POST /v1/tools/<nombre> (con el mapeo de errores a HTTP)', async () => {
    const list = await j(await fetch(`${b.base}/v1/tools`, { headers: auth(key) }));
    assert.ok(list.tools.length >= 20);
    const ok = await fetch(`${b.base}/v1/tools/list_peers`, { method: 'POST', headers: auth(key, 'rest'), body: '{}' });
    assert.equal(ok.status, 200);
    assert.equal((await j(ok)).ok, true);
    const nf = await fetch(`${b.base}/v1/tools/message_peer`, { method: 'POST', headers: auth(key, 'rest'), body: JSON.stringify({ peer: 'nadie', message: 'hola' }) });
    assert.equal(nf.status, 404);
    assert.equal((await j(nf)).error.code, 'unknown_peer');
  });

  it('nombre de sesión inválido: 400', async () => {
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(key, 'Con Espacios!'), body: '{}' });
    assert.equal(r.status, 400);
    assert.equal((await j(r)).error, 'bad_session_name');
  });

  it('clave revocada o agente desactivado dejan de valer', async () => {
    const k2 = b.agent('temporal');
    assert.equal((await tool(b.base, k2, 's', 'get_node_status')).ok, true);
    const extra = addKey(b.hub, 'temporal', { label: 'extra' });
    revokeKey(b.hub, 'extra');
    assert.equal((await rpc(b.base, extra.key, 's', 'ping')).status, 401);
    disableAgent(b.hub, 'temporal');
    assert.equal((await rpc(b.base, k2, 's', 'ping')).status, 401);
  });

  it('las cabeceras X-Session-* rellenan lo que falta pero no pisan lo que fijó el agente', async () => {
    const hdr = { ...auth(key, 'meta'), 'X-Session-Description': 'de la cabecera', 'X-Session-Harness': 'claude-code' };
    await fetch(`${b.base}/mcp`, { method: 'POST', headers: hdr, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal((await tool(b.base, key, 'meta', 'get_node_status')).data.session.description, 'de la cabecera');
    await tool(b.base, key, 'meta', 'set_session_info', { description: 'la que eligió el agente' });
    await fetch(`${b.base}/mcp`, { method: 'POST', headers: hdr, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
    const s = (await tool(b.base, key, 'meta', 'get_node_status')).data.session;
    assert.equal(s.description, 'la que eligió el agente');
    assert.equal(s.harness, 'claude-code');
  });

  it('una conexión reutilizada tras un 401 no se corta (keep-alive)', async () => {
    const http = await import('node:http');
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(`${b.base}/mcp`, { method: 'POST', agent, headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
      });
    assert.equal(await get({ 'Content-Type': 'application/json' }), 401);
    await new Promise((r) => setTimeout(r, 5500)); // más que el plazo de descarte
    assert.equal(await get(auth(key, 'ka')), 200);
    agent.destroy();
  });

  it('clave fijada a una sesión: sirve sin header y rechaza otro nombre', async () => {
    const pinned = addKey(b.hub, 'admin', { pinnedSession: 'fija' }).key;
    const st = await tool(b.base, pinned, undefined, 'get_node_status');
    assert.equal(st.data.identity.sessionName, 'fija');
    assert.equal(st.data.warnings.length, 0);
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(pinned, 'otra'), body: '{}' });
    assert.equal(r.status, 400);
    assert.equal((await j(r)).error, 'session_pinned');
  });
});

describe('límites', () => {
  it('rate limit por clave: 429 con Retry-After', async () => {
    const b = await boot({ ratePerMinute: 3 });
    const key = b.agent('a');
    for (let i = 0; i < 3; i++) assert.equal((await rpc(b.base, key, 's', 'ping')).status, 200);
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(key, 's'), body: '{}' });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    await b.close();
  });

  it('demasiados intentos con clave falsa desde una IP: 429', async () => {
    const b = await boot({ authFailPerMinute: 3 });
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${b.base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer aik_mala' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${b.base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer aik_mala' }, body: '{}' })).status, 429);
    await b.close();
  });

  it('tope de sesiones por agente', async () => {
    const b = await boot({ maxSessionsPerAgent: 2 });
    const key = b.agent('a');
    await tool(b.base, key, 's1', 'get_node_status');
    await tool(b.base, key, 's2', 'get_node_status');
    const r = await fetch(`${b.base}/mcp`, { method: 'POST', headers: auth(key, 's3'), body: '{}' });
    assert.equal(r.status, 429);
    assert.equal((await j(r)).error, 'too_many_sessions');
    await b.close();
  });
});
