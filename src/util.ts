import { randomBytes } from 'node:crypto';

/** Error esperado de una herramienta: se devuelve al agente con `code` y `message`, nunca revienta el servidor. */
export class ToolError extends Error {
  code: string;
  data: Record<string, unknown> | undefined;
  status: number;
  constructor(code: string, message: string, data?: Record<string, unknown>, status = 400) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.data = data;
    this.status = status;
  }
}

export const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

export const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

/** Minúsculas y sin acentos, para buscar «proyecto-a» igual que «proyecto-a». */
export const norm = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
