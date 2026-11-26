import { maintenance } from './admin.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createHttpServer } from './http.ts';
import { Hub, one } from './store.ts';

const cfg = loadConfig();
const hub = new Hub(cfg, openDb(cfg.dbPath));
// Al arrancar no hay ningún stream abierto: los contadores de presencia de la ejecución anterior no valen.
hub.db.exec('UPDATE sessions SET streams = 0, push_streams = 0 WHERE streams <> 0 OR push_streams <> 0');
const server = createHttpServer(hub);

server.listen(cfg.port, cfg.host, () => {
  console.log(`agent-intercom-hub escuchando en http://${cfg.host}:${cfg.port}  (scope ${cfg.scope}, base ${cfg.dbPath})`);
  if (!one(hub.db, 'SELECT 1 FROM api_keys WHERE revoked_at IS NULL')) {
    console.log('Aviso: no hay claves. Crea un agente y una clave:  npm run cli -- agent:add <id> --name "Nombre"  y  npm run cli -- key:add <id>');
  }
});

const timer = setInterval(() => {
  try {
    const r = maintenance(hub);
    if (r.messages || r.attachments || r.audit || r.connections) console.log('[mantenimiento]', r);
  } catch (e) {
    console.error('[mantenimiento]', e);
  }
}, 3_600_000);
timer.unref();

function shutdown(signal: string): void {
  console.log(`${signal}: cerrando…`);
  clearInterval(timer);
  hub.close();
  server.close(() => {
    hub.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
