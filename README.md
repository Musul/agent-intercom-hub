# agent-intercom-hub

Servidor MCP para que **sesiones de agentes** (Claude Code, otros harness, scripts) se hablen entre sí.
Sustituye el límite «una clave = una sesión» por **sesiones con nombre**: una persona puede tener a la vez
`ana/proyecto-a`, `ana/proyecto-b` y `ana/demo`, cada una con su buzón, y decirle a su agente:

> «Pregúntale a la sesión del proyecto-a de Ana si ya terminó el módulo.»

El agente llama a `list_peers(query: "proyecto-a ana")`, obtiene el id exacto `ana/proyecto-a` y le
escribe con `message_peer`. Si hubiera dudas, el servidor **no adivina**: devuelve `ambiguous_peer` con las candidatas.

- **Cero dependencias en ejecución.** Node ≥ 24 (`node:sqlite`, TypeScript sin compilar). Una sola base SQLite.
- **MCP por HTTP** (Streamable HTTP) + un espejo REST para `curl` y scripts. Cualquier cliente MCP que admita
  HTTP y cabeceras propias se conecta, sea del harness que sea.
- **Compatible con el servidor anterior:** mismos nombres de herramientas (`list_peers`, `message_peer`,
  `check_inbox`, `acknowledge_messages`, `message_receipt`, canales, tareas, adjuntos, `ask_user`) y las claves
  existentes se importan tal cual.

## Arranque rápido

```bash
npm install                     # solo herramientas de desarrollo (tipos); el servidor no necesita nada
npm test                        # 59 pruebas, todas por HTTP real contra el servidor

npm run cli -- agent:add ana --name "Ana Torres"
npm run cli -- key:add ana                  # imprime la clave UNA vez
npm start                                           # http://0.0.0.0:8787/mcp
```

Con Docker: `docker compose up -d --build` y, para administrar,
`docker compose exec intercom node src/cli.ts key:add ana`.

## Cómo se conecta una sesión

**Cada chat es una sesión, y la nombra el usuario.** Al conectarse, un chat nuevo no tiene nombre: el servidor se lo
pide al usuario con un formulario MCP (o el agente lo pregunta y llama a `register_session`). Si el nombre ya existe y
su chat está cerrado, retoma ese buzón; si está abierto en otro chat, pide otro. Clientes probados: Claude Code, Codex,
OpenCode (MCP), pi (extensión) y Antigravity (configuración documentada, sin probar). Guía por cliente:
[skill/agent-intercom/CONECTAR.md](skill/agent-intercom/CONECTAR.md).

La clave dice **quién eres**. Con el header **`X-Session-Name`** la sesión nace con nombre fijo (scripts, vigilantes, configuraciones antiguas):

```json
{
  "mcpServers": {
    "agent_intercom": {
      "type": "http",
      "url": "https://intercom.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${AGENT_INTERCOM_KEY}",
        "X-Session-Name": "proyecto-a"
      }
    }
  }
}
```

Guía completa (varias sesiones, `curl`, migración desde el servidor actual): [docs/guia-equipo.md](docs/guia-equipo.md).

## Documentación

| Documento | Para qué |
|---|---|
| [docs/guia-equipo.md](docs/guia-equipo.md) | Conectarse, nombrar sesiones, ejemplos `curl`, administrar claves, migrar |
| [docs/arquitectura.md](docs/arquitectura.md) | La lógica: identidades, sesiones, presencia, entrega, seguridad, límites |
| [docs/contrato.md](docs/contrato.md) | Contrato exacto: cabeceras, herramientas, errores, REST |
| [docs/adversarial.md](docs/adversarial.md) | Batería adversarial: alcance, escenarios y resultados |
| [docs/08-despliegue.md](docs/08-despliegue.md) | Despliegue self-hosted: arquitectura, instalación, seguridad, operación |

## Configuración (variables de entorno)

| Variable | Defecto | Significado |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Dónde escucha |
| `INTERCOM_DB` | `./data/intercom.db` | Archivo SQLite (en Docker, `/data/intercom.db`) |
| `INTERCOM_SCOPE` | `default` | Nombre del espacio de trabajo |
| `PRESENCE_RECENT_SECONDS` | `120` | Cuánto cuenta un chat sin stream como abierto tras su última petición |
| `PUSH_CONFIRM_SECONDS` | `300` | Un mensaje entregado en automático que no se recoge en este plazo deja la sesión `offline` (`sin_confirmar`) |
| `ASK_NAME_DELAY_MS` | `1500` | Espera antes de pedir el nombre por formulario (un cliente que reconecta al arrancar no ve dos) |
| `MAX_CONNECTIONS_PER_AGENT` / `CONNECTION_KEEP_DAYS` | `500` / `14` | Chats (conexiones MCP) que se guardan por agente y días que se conservan los cerrados |
| `RATE_LIMIT_PER_MINUTE` | `240` | Peticiones por minuto y por clave |
| `AUTH_FAIL_PER_MINUTE` | `30` | Claves falsas por minuto y por IP |
| `MAX_BODY_BYTES` | `1048576` | Tope del cuerpo de una petición |
| `MAX_ATTACHMENT_BYTES` | `524288` | Tope de un adjunto por MCP |
| `MAX_UPLOAD_BYTES` | `16777216` | Tope de un adjunto por REST (`POST /v1/attachments`) |
| `MAX_STORAGE_BYTES` | `1073741824` | Espacio total de adjuntos (507 al llenarse) |
| `MAX_CONCURRENT_UPLOADS` / `_DOWNLOADS` | `2` / `4` | Subidas y descargas grandes a la vez (cada subida de 16 MiB ocupa ~32 MiB de memoria) |
| `MAX_PENDING_PER_SESSION` | `1000` | Mensajes sin atender que admite un buzón |
| `MAX_STREAMS_PER_SESSION` / `MAX_WAITERS_PER_SESSION` | `5` / `5` | Streams SSE (por sesión o por chat) y esperas largas por sesión |
| `MAX_CHANNELS` / `MAX_OPEN_TASKS` / `MAX_OUTPUT_STREAMS` | `500` / `5000` / `200` | Topes globales |
| `REQUEST_TIMEOUT_SECONDS` | `60` | Plazo para recibir una petición completa |
| `MAX_CONNECTIONS` | `2000` | Conexiones simultáneas |
| `TRUST_PROXY_HOPS` | `1` | Proxies de confianza delante (se usa la IP que añadió el último) |
| `MAX_SESSIONS_PER_AGENT` | `200` | Sesiones por agente |
| `RETENTION_DAYS` | `30` | Días que se conservan mensajes cerrados y adjuntos |
| `TRUST_PROXY` | `false` | Detrás de Caddy/nginx: la IP sale de `X-Forwarded-For` |
| `ALLOWED_ORIGINS` | vacío | Orígenes de navegador permitidos (los clientes sin `Origin` siempre pasan) |

## Pruebas

- `npm test` — 59 pruebas por HTTP real contra el servidor.
- `node adversarial/run.mjs` — **batería adversarial en Docker**: contenedores endurecidos atacados desde fuera
  (autenticación, aislamiento, inyección, protocolo HTTP crudo, agotamiento de recursos, concurrencia, kill -9, disco lleno).
  Detalle y resultados en [docs/adversarial.md](docs/adversarial.md).

## Límites conocidos

- **Entrega automática** (la sesión figura `online`): Claude Code lanzado con el canal
  (`--dangerously-load-development-channels server:agent_intercom`; en planes Team/Enterprise el admin debe permitir
  `channelsEnabled`), la extensión de pi, o el **vigilante** (`intercom-watch.mjs`), que en Claude Code arranca solo mediante hooks (terminal: `asyncRewake`; VS Code: el agente
  lo lanza en segundo plano en su primera respuesta), y el **plugin de OpenCode**. Codex y Antigravity no pueden despertar un chat quieto: sus
  **hooks** entregan el mensaje al empezar, cuando el usuario escribe o cuando el agente termina un turno, y figuran
  `offline` (`sin_entrega_automatica`). Antigravity se conecta por un puente stdio local (`intercom-bridge.mjs`).
- Un solo nodo (SQLite, con copia en caliente: `intercom backup`). Alta disponibilidad real exigiría mover el almacenamiento
  a Postgres (reescritura de la capa de datos, que hoy es síncrona); no está hecho.
- Los flujos de salida se consultan por sondeo (`read_output` con `afterSeq`); no hay SSE por flujo.
