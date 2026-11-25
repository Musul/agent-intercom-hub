import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashKey } from './keys.ts';
import { handleRpc } from './mcp.ts';
import { fetchAttachment, storeAttachment } from './files.ts';
import { ensureSession, type SessionMeta } from './peers.ts';
import { one, run, type AgentRow, type Ctx, type Hub } from './store.ts';
import { callTool, TOOLS } from './tools.ts';
import { ToolError } from './util.ts';

/** Contador por ventana de un minuto (límites de peticiones y de intentos de autenticación fallidos). */
class Counter {
  private m = new Map<string, { start: number; n: number }>();
  /** Devuelve los segundos que faltan para poder reintentar si se pasó el límite; 0 si todo bien. */
  hit(key: string, limit: number, now = Date.now()): number {
    if (this.m.size > 10_000) for (const [k, v] of this.m) if (now - v.start > 60_000) this.m.delete(k);
    let e = this.m.get(key);
    if (!e || now - e.start >= 60_000) this.m.set(key, (e = { start: now, n: 0 }));
    e.n++;
    return e.n > limit ? Math.max(1, Math.ceil((e.start + 60_000 - now) / 1000)) : 0;
  }
  over(key: string, limit: number, now = Date.now()): number {
    const e = this.m.get(key);
    return e && now - e.start < 60_000 && e.n >= limit ? Math.max(1, Math.ceil((e.start + 60_000 - now) / 1000)) : 0;
  }
}

const SEC_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...SEC_HEADERS, ...extra });
  res.end(data);
}

const DRAIN_MAX = 1024 * 1024;
/** Para un 413 o un 429 de subida: se deja terminar de llegar un cuerpo grande (con tope y plazo) para que el cliente lea el error en vez de un reset. */
const LINGER_MAX = 64 * 1024 * 1024;

/**
 * Respuesta de error SIN haber leído (ni interpretado) el cuerpo: la autenticación y el tamaño se miran antes.
 * El cuerpo que siga llegando se descarta con tope (`drainMax`) y plazo (5 s) y luego se corta la conexión si no terminó;
 * si termina a tiempo, la conexión sigue siendo reutilizable.
 */
function sendAndClose(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}, drainMax = DRAIN_MAX): void {
  sendJson(res, status, body, extra);
  let n = 0;
  const kill = setTimeout(() => req.socket.destroy(), 5000);
  kill.unref();
  req.on('data', (c: Buffer) => {
    n += c.length;
    if (n > drainMax) req.socket.destroy();
  });
  // El plazo solo vale para un cuerpo que no termina: si ya terminó, la conexión puede reutilizarse.
  req.on('end', () => clearTimeout(kill));
  req.on('close', () => clearTimeout(kill));
}

interface Auth {
  agent: AgentRow;
  keyId: string;
  pinned: string | null;
}

function authenticate(hub: Hub, req: IncomingMessage): Auth | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const row = one<AgentRow & { key_id: string; pinned_session: string | null }>(
    hub.db,
    `SELECT k.id AS key_id, k.pinned_session AS pinned_session, a.*
       FROM api_keys k JOIN agents a ON a.id = k.agent_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.disabled_at IS NULL`,
    hashKey(m[1]!),
  );
  if (!row) return null;
  const { key_id, pinned_session, ...agent } = row;
  return { agent, keyId: key_id, pinned: pinned_session };
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return ((Array.isArray(v) ? v[0] : v) ?? '').trim() || undefined;
};

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) return reject(new ToolError('payload_too_large', `El cuerpo pasa de ${max} bytes.`, undefined, 413));
    const declared = Number(req.headers['content-length']);
    const whole = Number.isInteger(declared) && declared > 65_536 ? Buffer.allocUnsafe(declared) : undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    let dead = false;
    req.on('data', (c: Buffer) => {
      if (dead) return;
      if (size + c.length > max) {
        dead = true;
        reject(new ToolError('payload_too_large', `El cuerpo pasa de ${max} bytes.`, undefined, 413));
      } else if (whole) {
        c.copy(whole, size);
        size += c.length;
      } else {
        chunks.push(c);
        size += c.length;
      }
    });
    req.on('end', () => !dead && resolve(whole ? whole.subarray(0, size) : Buffer.concat(chunks)));
    req.on('error', (e) => !dead && reject(e));
  });
}

async function buildCtx(hub: Hub, req: IncomingMessage, url: URL, auth: Auth, res: ServerResponse): Promise<Ctx> {
  const asked = (header(req, 'x-session-name') ?? url.searchParams.get('session') ?? undefined)?.toLowerCase();
  let name: string;
  if (auth.pinned) {
    if (asked && asked !== auth.pinned) throw new ToolError('session_pinned', `Esta clave está fijada a la sesión «${auth.pinned}»; no puede usar «${asked}».`);
    name = auth.pinned;
  } else name = asked ?? 'default';
  const description = header(req, 'x-session-description');
  const harness = header(req, 'x-session-harness');
  const cwd = header(req, 'x-session-cwd');
  const meta: SessionMeta = {
    ...(description !== undefined ? { description: description.slice(0, 300) } : {}),
    ...(harness !== undefined ? { harness: harness.slice(0, 40) } : {}),
    ...(cwd !== undefined ? { cwd: cwd.slice(0, 200) } : {}),
  };
  const now = Date.now();
  const session = ensureSession(hub, auth.agent, name, meta, now);
  run(hub.db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, auth.keyId);
  const warnings: string[] = [];
  if (name === 'default' && !auth.pinned) {
    warnings.push('Sesión sin nombre: usa el header X-Session-Name para que tus compañeros te distingan de otras sesiones de la misma clave.');
  }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  return { hub, agent: auth.agent, session, keyId: auth.keyId, warnings, now, signal: ac.signal };
}

/** IP del cliente. Detrás de un proxy de confianza se toma la entrada que añadió ÉL (la de la derecha), nunca la que el cliente pueda haber puesto. */
function clientIp(hub: Hub, req: IncomingMessage): string {
  if (hub.cfg.trustProxy) {
    const parts = (header(req, 'x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = parts[parts.length - hub.cfg.trustProxyHops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Tipos que se devuelven tal cual en una descarga; el resto sale como binario (nunca HTML ni SVG que un navegador ejecute). */
const DOWNLOAD_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function restFail(req: IncomingMessage, res: ServerResponse, e: unknown): void {
  if (e instanceof ToolError) return sendAndClose(req, res, e.status, { ok: false, error: { code: e.code, message: e.message, ...(e.data ?? {}) } }, {}, e.status === 413 ? LINGER_MAX : DRAIN_MAX);
  throw e;
}

async function handle(hub: Hub, req: IncomingMessage, res: ServerResponse, rate: Counter, fails: Counter): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return sendAndClose(req, res, 400, { error: 'bad_url' });
  }
  const path = url.pathname;
  const cfg = hub.cfg;

  if (path === '/healthz') return sendJson(res, 200, { ok: true, scope: cfg.scope });
  if (path !== '/mcp' && !path.startsWith('/v1/')) return sendJson(res, 404, { error: 'not_found' });

  const origin = header(req, 'origin');
  if (origin && !cfg.allowedOrigins.includes(origin)) return sendAndClose(req, res, 403, { error: 'origin_not_allowed' });

  const ip = clientIp(hub, req);
  // Dos cabeceras Authorization son ambiguas (Node se queda con la primera, otro proxy podría quedarse con la última): se rechazan.
  const duplicatedAuth = req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'authorization').length > 1;
  const auth = duplicatedAuth ? null : authenticate(hub, req);
  if (!auth) {
    const wait = fails.over(ip, cfg.authFailPerMinute);
    if (wait) return sendAndClose(req, res, 429, { error: 'too_many_auth_failures' }, { 'Retry-After': String(wait) });
    fails.hit(ip, cfg.authFailPerMinute);
    return sendAndClose(req, res, 401, { error: 'invalid_api_key' }, { 'WWW-Authenticate': 'Bearer realm="agent-intercom"' });
  }
  const limited = rate.hit(auth.keyId, cfg.ratePerMinute);
  if (limited) return sendAndClose(req, res, 429, { error: 'rate_limited' }, { 'Retry-After': String(limited) });

  let ctx: Ctx;
  try {
    ctx = await buildCtx(hub, req, url, auth, res);
  } catch (e) {
    if (e instanceof ToolError) return sendAndClose(req, res, e.status, { error: e.code, message: e.message });
    throw e;
  }

  if (path === '/mcp') {
    if (req.method === 'GET' && (header(req, 'accept') ?? '').includes('text/event-stream')) return openStream(hub, ctx, req, res);
    if (req.method !== 'POST') return sendAndClose(req, res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString('utf8'));
    } catch (e) {
      if (e instanceof ToolError) return sendAndClose(req, res, e.status, { error: e.code, message: e.message }, {}, e.status === 413 ? LINGER_MAX : DRAIN_MAX);
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido.' } });
    }
    const { payload } = await handleRpc(ctx, body);
    if (payload === undefined) {
      res.writeHead(202, SEC_HEADERS);
      return void res.end();
    }
    return sendJson(res, 200, payload);
  }

  // Espejo REST de las herramientas, para curl y scripts: GET /v1/tools · POST /v1/tools/<nombre>
  if (path === '/v1/tools' && req.method === 'GET') {
    return sendJson(res, 200, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  // Adjuntos grandes por REST (hasta MAX_UPLOAD_BYTES): POST con el archivo en bruto y GET para bajarlo.
  if (path === '/v1/attachments' && req.method === 'POST') {
    if (hub.activeUploads >= cfg.maxConcurrentUploads) {
      return sendAndClose(req, res, 429, { ok: false, error: { code: 'too_many_uploads', message: 'Hay demasiadas subidas a la vez; reintenta en unos segundos.' } }, { 'Retry-After': '2' }, LINGER_MAX);
    }
    hub.activeUploads++;
    try {
      const data = await readBody(req, cfg.maxUploadBytes);
      let name = header(req, 'x-file-name') ?? url.searchParams.get('name') ?? 'archivo';
      try {
        name = decodeURIComponent(name);
      } catch {
        /* se deja tal cual */
      }
      return sendJson(res, 201, { ok: true, result: storeAttachment(ctx, name, data, header(req, 'content-type'), cfg.maxUploadBytes) });
    } catch (e) {
      return restFail(req, res, e);
    } finally {
      hub.activeUploads--;
    }
  }
  const dl = /^\/v1\/attachments\/(att_[0-9a-f]{24})$/.exec(path);
  if (dl && req.method === 'GET') {
    if (hub.activeDownloads >= cfg.maxConcurrentDownloads) {
      return sendJson(res, 429, { ok: false, error: { code: 'too_many_downloads', message: 'Hay demasiadas descargas a la vez; reintenta en unos segundos.' } }, { 'Retry-After': '2' });
    }
    hub.activeDownloads++;
    res.on('close', () => hub.activeDownloads--);
    try {
      const { meta, data } = fetchAttachment(ctx, dl[1]!);
      res.writeHead(200, {
        'Content-Type': DOWNLOAD_TYPES.has(meta.media_type) ? meta.media_type : 'application/octet-stream',
        'Content-Length': data.length,
        'Content-Disposition': 'attachment; filename="download"; filename*=UTF-8\'\'' + encodeURIComponent(meta.name),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...SEC_HEADERS,
      });
      return void res.end(data);
    } catch (e) {
      return restFail(req, res, e);
    }
  }
  const m = /^\/v1\/tools\/([a-z_]+)$/.exec(path);
  if (m && req.method === 'POST') {
    let args: unknown = {};
    try {
      const raw = (await readBody(req, cfg.maxBodyBytes)).toString('utf8');
      if (raw.trim()) args = JSON.parse(raw);
    } catch (e) {
      if (e instanceof ToolError) return sendAndClose(req, res, e.status, { ok: false, error: { code: e.code, message: e.message } }, {}, e.status === 413 ? LINGER_MAX : DRAIN_MAX);
      return sendJson(res, 400, { ok: false, error: { code: 'invalid_json', message: 'JSON inválido.' } });
    }
    const r = await callTool(ctx, m[1]!, args);
    return r.ok ? sendJson(res, 200, { ok: true, result: r.result }) : sendJson(res, r.error.status, { ok: false, error: r.error });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

/** GET /mcp con Accept: text/event-stream. Mientras esté abierta, la sesión figura «online»; además recibe un aviso por cada mensaje nuevo. */
function openStream(hub: Hub, ctx: Ctx, req: IncomingMessage, res: ServerResponse): void {
  if ((hub.streams.get(ctx.session.id)?.size ?? 0) >= hub.cfg.maxStreamsPerSession) {
    return sendJson(res, 429, { error: 'too_many_streams', message: 'Esta sesión ya tiene demasiadas conexiones SSE abiertas.' });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', ...SEC_HEADERS, Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  const client = { write: (s: string) => void res.write(s), end: () => void res.end() };
  hub.addStream(ctx.session.id, client);
  const timer = setInterval(() => res.write(': ping\n\n'), hub.cfg.sseKeepaliveMs);
  timer.unref();
  res.on('close', () => {
    clearInterval(timer);
    hub.removeStream(ctx.session.id, client);
    const now = Date.now();
    run(hub.db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, ctx.session.id);
    hub.lastTouch.set(ctx.session.id, now);
  });
}

export function createHttpServer(hub: Hub): http.Server {
  const rate = new Counter();
  const fails = new Counter();
  // Node comprueba headersTimeout/requestTimeout solo cada `connectionsCheckingInterval` (30 s por defecto): se acorta.
  const checkEvery = Math.max(500, Math.min(5000, Math.floor(hub.cfg.requestTimeoutMs / 3)));
  const server = http.createServer({ connectionsCheckingInterval: checkEvery }, (req, res) => {
    // Con una petición en curso (espera larga, SSE) el socket puede callar; los plazos de arriba ya cubren los cuerpos que gotean.
    req.socket.setTimeout(0);
    handle(hub, req, res, rate, fails).catch((e) => {
      console.error('[http]', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  // Una conexión que abre el socket y no envía NADA nunca llega a headersTimeout: se cierra por inactividad.
  server.on('connection', (socket) => {
    socket.setTimeout(hub.cfg.requestTimeoutMs);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = Math.min(20_000, hub.cfg.requestTimeoutMs);
  server.requestTimeout = hub.cfg.requestTimeoutMs; // un cuerpo que gotea no retiene la conexión indefinidamente
  server.maxConnections = hub.cfg.maxConnections;
  server.maxHeadersCount = 100; // una petición legítima trae menos de 20 cabeceras
  return server;
}
