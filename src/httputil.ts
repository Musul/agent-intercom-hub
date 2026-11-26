import type { IncomingMessage, ServerResponse } from 'node:http';
import { ToolError } from './util.ts';

/** Utilidades HTTP compartidas por la API (http.ts) y el panel web (web.ts). */

/** Contador por ventana de un minuto (límites de peticiones y de intentos de autenticación fallidos). */
export class Counter {
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

export const SEC_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...SEC_HEADERS, ...extra });
  res.end(data);
}

export const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return ((Array.isArray(v) ? v[0] : v) ?? '').trim() || undefined;
};

export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
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
