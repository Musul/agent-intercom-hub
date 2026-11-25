import { createHash, randomBytes } from 'node:crypto';

/** Clave nueva: se muestra UNA vez al crearla; en la base solo queda su hash. */
export const generateKey = (): string => `aik_${randomBytes(24).toString('base64url')}`;

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
