export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** Espacio de trabajo único de esta instancia (aparece en `get_node_status` y en cada mensaje). */
  scope: string;
  /** Una conexión MCP sin stream abierto cuenta como «chat abierto» este tiempo tras su última petición. */
  recentMs: number;
  /** Un mensaje entregado en automático (push) que la sesión no confirma en este plazo la deja «offline». */
  pushConfirmMs: number;
  /** Conexiones MCP (chats) que conserva cada agente; las más viejas se cierran. */
  maxConnectionsPerAgent: number;
  /** Días que se conservan las conexiones cerradas o inactivas. */
  connectionKeepDays: number;
  /** Espera antes de pedir el nombre por formulario (un cliente que reconecta al arrancar no ve dos formularios). */
  askNameDelayMs: number;
  /** Peticiones autenticadas por minuto y por clave. */
  ratePerMinute: number;
  /** Intentos fallidos de autenticación por minuto y por IP. */
  authFailPerMinute: number;
  maxBodyBytes: number;
  /** Adjunto por MCP (base64 dentro del JSON). */
  maxAttachmentBytes: number;
  /** Adjunto por REST (`POST /v1/attachments`, cuerpo en bruto). */
  maxUploadBytes: number;
  /** Espacio total de adjuntos; al llegar al tope se rechazan los nuevos. */
  maxStorageBytes: number;
  maxConcurrentUploads: number;
  maxConcurrentDownloads: number;
  maxMessageChars: number;
  maxSessionsPerAgent: number;
  /** Mensajes sin confirmar que admite el buzón de UNA sesión (frena inundaciones). */
  maxPendingPerSession: number;
  maxStreamsPerSession: number;
  maxWaitersPerSession: number;
  maxChannels: number;
  maxOpenTasks: number;
  maxOutputStreams: number;
  /** Entradas que conserva cada flujo de salida (las más nuevas). */
  outputKeep: number;
  outputMaxBytes: number;
  sseKeepaliveMs: number;
  /** Plazo para recibir una petición completa (frena los cuerpos que gotean). */
  requestTimeoutMs: number;
  maxConnections: number;
  /** Los mensajes ya procesados y los adjuntos se conservan este número de días. */
  retentionDays: number;
  /** Detrás de Caddy/nginx: la IP del cliente sale de X-Forwarded-For. */
  trustProxy: boolean;
  /** Cuántos proxies de confianza hay delante: se toma la entrada que añadió el último (la de la derecha). */
  trustProxyHops: number;
  /** Orígenes de navegador permitidos (vacío = ninguno; las peticiones sin `Origin` siempre pasan). */
  allowedOrigins: string[];
  /** Mensajes por hora que pueden DESPERTAR una sesión (los demás quedan en cola sin despertarla). 0 = sin tope. */
  wakePerHour: number;
  /** Idas y vueltas seguidas entre dos sesiones sin turno humano antes de pausar la conversación. 0 = sin freno. */
  loopMaxExchanges: number;
  /** Tras este tiempo sin mensajes entre dos sesiones, su contador de bucle vuelve a cero. */
  loopResetMs: number;
  /** Nombrar solo el chat con la sugerencia del cliente (carpeta + rama) si el cliente lo pide (X-Session-Auto: 1). */
  autoName: boolean;
  /** Panel web: horas que dura una sesión iniciada. */
  webSessionHours: number;
  /** Panel web: `own` = cada persona ve las conversaciones de sus sesiones; `all` = todas las del espacio. */
  webVisibility: 'own' | 'all';
  /** URL pública (https://intercom.example.com) para los enlaces de invitación y del panel. Vacío = la del Host. */
  publicUrl: string;
  /** Horas que vale una invitación sin usar. */
  inviteHours: number;
  /** Copias automáticas: carpeta (vacío = desactivadas), cada cuántas horas y cuántas se conservan. */
  backupDir: string;
  backupEveryHours: number;
  backupKeep: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<Config> = {}): Config {
  return {
    port: num(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    dbPath: env.INTERCOM_DB || './data/intercom.db',
    scope: env.INTERCOM_SCOPE || 'default',
    recentMs: num(env.PRESENCE_RECENT_SECONDS, 120) * 1000,
    pushConfirmMs: num(env.PUSH_CONFIRM_SECONDS, 300) * 1000,
    maxConnectionsPerAgent: num(env.MAX_CONNECTIONS_PER_AGENT, 500),
    connectionKeepDays: num(env.CONNECTION_KEEP_DAYS, 14),
    askNameDelayMs: num(env.ASK_NAME_DELAY_MS, 1500),
    ratePerMinute: num(env.RATE_LIMIT_PER_MINUTE, 240),
    authFailPerMinute: num(env.AUTH_FAIL_PER_MINUTE, 30),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 1024 * 1024),
    maxAttachmentBytes: num(env.MAX_ATTACHMENT_BYTES, 512 * 1024),
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 16 * 1024 * 1024),
    maxStorageBytes: num(env.MAX_STORAGE_BYTES, 1024 * 1024 * 1024),
    maxConcurrentUploads: num(env.MAX_CONCURRENT_UPLOADS, 2),
    maxConcurrentDownloads: num(env.MAX_CONCURRENT_DOWNLOADS, 4),
    maxMessageChars: num(env.MAX_MESSAGE_CHARS, 32 * 1024),
    maxSessionsPerAgent: num(env.MAX_SESSIONS_PER_AGENT, 200),
    maxPendingPerSession: num(env.MAX_PENDING_PER_SESSION, 1000),
    maxStreamsPerSession: num(env.MAX_STREAMS_PER_SESSION, 5),
    maxWaitersPerSession: num(env.MAX_WAITERS_PER_SESSION, 5),
    maxChannels: num(env.MAX_CHANNELS, 500),
    maxOpenTasks: num(env.MAX_OPEN_TASKS, 5000),
    maxOutputStreams: num(env.MAX_OUTPUT_STREAMS, 200),
    outputKeep: num(env.OUTPUT_KEEP, 1000),
    outputMaxBytes: num(env.OUTPUT_MAX_BYTES, 64 * 1024),
    sseKeepaliveMs: num(env.SSE_KEEPALIVE_SECONDS, 15) * 1000,
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_SECONDS, 60) * 1000,
    maxConnections: num(env.MAX_CONNECTIONS, 2000),
    retentionDays: num(env.RETENTION_DAYS, 30),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    trustProxyHops: Math.max(1, num(env.TRUST_PROXY_HOPS, 1)),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    wakePerHour: Math.max(0, num(env.WAKE_PER_HOUR, 30)),
    loopMaxExchanges: Math.max(0, num(env.LOOP_MAX_EXCHANGES, 10)),
    loopResetMs: num(env.LOOP_RESET_MINUTES, 30) * 60_000,
    autoName: env.AUTO_NAME !== '0' && env.AUTO_NAME !== 'false',
    webSessionHours: num(env.WEB_SESSION_HOURS, 12),
    webVisibility: env.WEB_VISIBILITY === 'all' ? 'all' : 'own',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    inviteHours: num(env.INVITE_HOURS, 48),
    backupDir: env.BACKUP_DIR || '',
    backupEveryHours: num(env.BACKUP_EVERY_HOURS, 24),
    backupKeep: Math.max(1, num(env.BACKUP_KEEP, 14)),
    ...over,
  };
}
