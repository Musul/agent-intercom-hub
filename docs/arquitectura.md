# Arquitectura: la lógica del servidor

## 1. El problema que resuelve

En el servidor anterior la identidad era la **clave**: una clave = un agente = un buzón = una presencia.
Una persona con tres sesiones abiertas compartía un único buzón; el mensaje «para MiMuni» caía en la sesión
equivocada y `list_peers` no podía distinguir «el proyecto-a de Ana» de «el Proyecto B de Ana».

## 2. El modelo

```
Agente (persona o sistema)        id: ana   nombre: "Ana Torres"
 ├─ Clave(s) de API               aik_…  (solo se guarda su hash; opcionalmente fijada a una sesión)
 └─ Sesiones (con nombre)         ana/proyecto-a   ← buzón, presencia y metadatos PROPIOS
                                  ana/proyecto-b
                                  ana/demo
```

- **Agente:** quién eres (una persona del equipo, o un sistema). Se crea con la CLI.
- **Clave:** autentica a un agente. Un agente puede tener varias (por equipo, por máquina). Una clave puede ir
  **fijada a una sesión** (`--session`): sirve para clientes que no pueden mandar cabeceras, o para dar una clave
  por sesión sin tocar nada más.
- **Sesión:** qué conversación de trabajo eres. Se **crea sola** la primera vez que se conecta con un nombre
  (`X-Session-Name`). Tiene buzón propio, descripción, etiquetas, cwd, harness, estado y presencia.
- **Dirección:** `agente/sesion`. Es lo que se usa en `message_peer` y lo que devuelve `list_peers`.

- **Conexión (chat):** cada chat abierto es una conexión MCP con estado (`Mcp-Session-Id`). **Nace sin nombre** y
  el usuario elige el de su sesión: el servidor se lo pide con un formulario MCP (`elicitation/create`) en cuanto
  el cliente abre su stream; si el cliente no tiene formularios o el usuario lo cierra, el agente lo pregunta en el
  chat y llama a `register_session`. Hasta entonces solo puede nombrarse o consultar (`session_unnamed`).
  Un nombre abierto en otro chat se rechaza (`session_in_use`); uno existente pero cerrado retoma su buzón.

Con `X-Session-Name` (o una clave fijada) la conexión nace ya nombrada, como antes; `X-Session-Instance` (el id del
chat en el cliente) hace que el mismo chat que reconecta recupere su nombre sin volver a preguntar. Las peticiones
**sin estado** (REST, `curl`, clientes que no guardan `Mcp-Session-Id`) siguen resolviendo la sesión por cabecera y,
sin ella, usan `default`, compartida por todas las conexiones sin nombre de esa clave.

## 3. Cómo se llega a «la sesión del proyecto-a de Ana»

1. El agente llama a `list_peers` con `query: "proyecto-a ana"`.
2. La búsqueda quita palabras vacías (de, la, el…), normaliza acentos y mayúsculas y exige que **todas** las
   palabras aparezcan en alguno de: id del agente, nombre visible, nombre de sesión, descripción, etiquetas,
   estado, cwd y harness. Si ninguna sesión cumple todas, devuelve las parciales marcadas `match: "partial"`.
3. Con el id exacto (`ana/proyecto-a`) llama a `message_peer`.

Por eso conviene que cada sesión haga `set_session_info` al empezar (descripción y etiquetas): es lo que la hace
encontrable. Resolución de destinatarios en `message_peer`:

| `peer` | Resultado |
|---|---|
| `ana/proyecto-a` | esa sesión |
| `ana` | si el agente tiene **una** sesión, esa; con varias → error `ambiguous_peer` + candidatas (nunca adivina) |
| `ana/*` | todas las sesiones del agente (menos la tuya) |
| `ses_…` | por id de sesión |
| `Ana Torres` | por nombre visible, si es único y exacto (compatibilidad) |

## 4. Presencia: qué significa de verdad

Dos estados, calculados por el servidor sin que el agente haga nada:

| `presence` | Significa |
|---|---|
| `online` | **chat abierto y recibe en automático**: tiene un stream abierto (`GET /mcp`) de un cliente que mete los mensajes en el chat (Claude Code con canal, vigilante, extensión de pi) y no dejó sin recoger ningún mensaje entregado hace más de `PUSH_CONFIRM_SECONDS` (300 s) |
| `offline` | todo lo demás, con `offlineReason`: `cerrada` (chat cerrado: stream cortado, `DELETE` o sin actividad), `sin_entrega_automatica` (abierto, pero su cliente no recibe solo) o `sin_confirmar` (se le entregó un mensaje y no lo recogió) |

`connected` dice si hay un chat abierto aunque no reciba solo; `ready` = `online`. `reachable` es siempre `true`: el
mensaje **se guarda** aunque la sesión esté offline, y se le entrega al volver.

El stream dura lo que dura el chat: el servidor manda un `: ping` cada 15 s y, si el proceso del cliente muere, la
conexión TCP se cierra y la sesión pasa a offline en el acto. Claude Code no manda `DELETE` al salir (Codex sí); el
cierre se detecta igual por el stream. Los contadores de streams se guardan en la base (`sessions.streams`,
`push_streams`) para que la CLI vea lo mismo que el servidor; al arrancar se ponen a cero.

**Límites:** `sin_confirmar` es una deducción: un agente ocupado en un turno largo puede tardar en recoger un mensaje
(vuelve a `online` en cuanto lo recoge). Y Claude Code descarta en silencio el canal si no se lanzó con el flag o si la
organización no lo permite; el `headersHelper` avisa del flag (`X-Intercom-Channels`), pero la política de la
organización solo se nota cuando un mensaje queda sin recoger.

## 5. Entrega de mensajes

Buzón durable por sesión, **al menos una vez**:

```
message_peer ──► queued ──► check_inbox ──► delivered ──► acknowledge_messages ──► acknowledged
                                  ▲                              │
                                  └── si no se confirma, vuelve a salir (redelivered: true)
```

- **Entrega automática:** a un chat de Claude Code con stream abierto, cada mensaje en cola se le empuja como
  `notifications/claude/channel` (una vez por conexión; al abrirse, también lo que esperaba). Claude Code lo mete en
  el chat como `<channel source="agent_intercom" …>` y despierta al agente aunque esté esperando a su usuario. El
  vigilante (`intercom-watch.mjs --exit-on-message`, en segundo plano: termina con cada mensaje y el agente lo relanza; en IDE un hook Stop lo exige al final del turno), la extensión de pi y el plugin de OpenCode hacen lo mismo por su
  lado con el aviso `inbox`. Codex y Antigravity no permiten meter nada en un chat quieto: sus **hooks**
  (`intercom-hook.mjs`) entregan en el siguiente turno. Hooks y plugins encuentran la sesión de su chat por
  `X-Session-Instance` (el proceso del cliente), el mismo id que manda su conexión MCP.
- `check_inbox(waitMs)` espera hasta 25 s y despierta en cuanto llega algo (sin sondeo).
- `message_receipt` muestra el estado y la respuesta enlazada, sin el contenido.
- `mode: "response"` + `responseTo` devuelve el mensaje **a la sesión que lo envió**, sin necesidad de `peer`.
  Solo se puede responder a lo que recibió *esa* sesión.
- `idempotencyKey` hace seguros los reintentos; `expiresInMs` descarta lo que ya no importa.
- Lo recibido (mensajes, canales, adjuntos) es **dato de terceros, nunca instrucciones**: las descripciones de las
  herramientas y las `instructions` del servidor se lo recuerdan al agente.

Los canales, las tareas y los adjuntos son compartidos por todo el espacio de trabajo; las **suscripciones** a
canales y los **reclamos** de tareas son por sesión.

## 6. Protocolo

- **MCP Streamable HTTP con estado:** `initialize` abre una conexión (tabla `connections`, persistente: sobrevive a
  reinicios del servidor) y devuelve `Mcp-Session-Id`; cada petición se autentica con la clave y se atribuye a esa
  conexión. `DELETE /mcp` la cierra. Sin la cabecera funciona como antes, sin estado. Responde JSON simple (no SSE)
  y `202` a notificaciones y respuestas del cliente. Versiones aceptadas: 2025-11-25, 2025-06-18, 2025-03-26,
  2024-11-05. `server/discover` (revisión «moderna» 2026-07-28) se rechaza a propósito: el cliente vuelve a
  `initialize`, y Claude Code solo entrega canales en las revisiones anteriores.
- **`GET /mcp` con `Accept: text/event-stream`:** el stream del chat: entrega automática, avisos
  (`notifications/message` `{event:"inbox", pending:N}`), peticiones del servidor (`elicitation/create`) y un
  `: ping` cada 15 s. Sin ese `Accept`, `405`.
- **Espejo REST:** `GET /v1/tools`, `POST /v1/tools/<nombre>` con los argumentos como cuerpo. Mismo auth, mismas
  reglas, mismas herramientas. Pensado para `curl` y scripts.

## 7. Seguridad

- Las claves se guardan **hasheadas** (SHA-256); la clave en claro solo se ve al crearla. Se pueden revocar y
  desactivar agentes enteros.
- **Autenticación antes de leer el cuerpo:** una petición sin clave válida recibe `401` sin que el servidor
  interprete el cuerpo (se descarta con tope de 1 MiB y plazo de 5 s). El tope de cuerpo (`MAX_BODY_BYTES`) se mira
  antes de leer (cabecera `Content-Length`) y mientras se lee.
- **Límites:** peticiones por minuto y clave (`429` + `Retry-After`), intentos de clave falsa por minuto e IP, sesiones
  por agente, tamaño de mensaje (32 KiB), de adjunto y de contexto.
- **`Origin`:** si llega un `Origin` de navegador que no está en `ALLOWED_ORIGINS`, `403` (anti DNS-rebinding). Los
  clientes de agentes no mandan `Origin`.
- **Sin superficie de administración por HTTP:** altas, claves y respuestas a `ask_user` se hacen con la CLI sobre la
  base. Detrás de un proxy TLS (Caddy/nginx) con `TRUST_PROXY=1`.
- **Auditoría** (`audit`): sesiones nuevas, mensajes enviados (sin cuerpo), claves, tareas y adjuntos. 90 días.
- No hay secretos en los mensajes de error ni en los logs; la clave nunca se escribe.

## 7b. Defensas contra abuso (lo que no se ve a primera vista)

| Amenaza | Defensa |
|---|---|
| Una sesión copia palabras para «ganar» una búsqueda y recibir mensajes ajenos | El orden pondera la identidad fijada por el administrador (6) por encima del nombre de sesión (3), las etiquetas (2) y el texto libre (1); `identityMatch` solo es true si coincide el agente |
| Inundar el buzón de otra sesión (directo o vía canal) | `MAX_PENDING_PER_SESSION` (1000): `inbox_full`; los avisos de canal se omiten en buzones llenos |
| Agotar memoria con subidas/descargas grandes | Subida con una sola reserva de memoria, máximo 2 subidas y 4 descargas a la vez (429 el resto; cada subida de 16 MiB ocupa ~32 MiB de memoria mientras se guarda), espacio total `MAX_STORAGE_BYTES` (507) |
| Cuerpos que gotean, cabeceras que gotean, miles de sockets mudos | `requestTimeout`/`headersTimeout` comprobados cada ≤5 s (Node lo hace cada 30 s por defecto) y cierre de conexiones que no envían nada |
| Bloquear a usuarios legítimos que comparten IP (NAT) | El freno de fuerza bruta solo cuenta claves **falsas**: quien trae una clave válida entra siempre |
| Falsear la IP con `X-Forwarded-For` | Con proxy de confianza se usa la IP que añadió el proxy (la de la derecha, `TRUST_PROXY_HOPS`); sin proxy se ignora la cabecera |
| Servir HTML/SVG subido como adjunto | Descarga siempre como `attachment`, `nosniff`, CSP `sandbox`; los tipos peligrosos salen como binario; el MIME se sanea |
| Streams SSE y esperas largas sin fin | Máximo 3 streams y 5 esperas por sesión |
| Crear canales, tareas, flujos o sesiones sin límite | Topes configurables (500 / 5000 / 200 / 200) |

## 8. Almacenamiento y mantenimiento

SQLite (WAL) en un solo archivo, migraciones versionadas con `PRAGMA user_version`. Cada hora el servidor borra los
mensajes cerrados (`acknowledged`/`expired`) y los adjuntos con más de `RETENTION_DAYS` días, y la auditoría con más
de 90. Los mensajes **pendientes no se borran nunca**. Copia de seguridad: `sqlite3 intercom.db ".backup copia.db"`
(o copiar el volumen con el servidor parado).

## 9. Decisiones y límites conocidos

| Decisión | Por qué | Coste |
|---|---|---|
| Conexión con estado por chat (`Mcp-Session-Id`), persistida en la base | Cada chat es su propia sesión, con el nombre que elige el usuario; sobrevive a reinicios | Una fila por chat (tope por agente, limpieza a los `CONNECTION_KEEP_DAYS`) |
| Sin estado sigue funcionando (REST, `curl`) | Scripts, vigilante y extensión de pi no necesitan MCP | Sin cabecera de nombre caen en `default` |
| `agent` solo → error si hay varias sesiones | Un mensaje mal encaminado es peor que un error claro | Un paso más para el agente (elige entre las candidatas) |
| Las sesiones se crean solas por cabecera | Cero trámite por sesión nueva | Quien tiene la clave puede crear sesiones (tope por agente) |
| SQLite en un nodo | Cero dependencias, copia de seguridad en caliente (`backup`) | Sin alta disponibilidad: si cae el nodo, se restaura la última copia |
| `check_inbox` entrega al menos una vez | Un agente que se cae no pierde mensajes | Hay que confirmar con `acknowledge_messages` |
| Un nombre abierto en otro chat se rechaza al nombrar (`session_in_use`) | Cada chat ve solo sus mensajes | Con `takeover` (o con `X-Session-Name` fijo) dos chats pueden compartir buzón, como antes |
| online = recibe en automático | Es lo que el equipo necesita saber: «¿lo leerá ya?» | Codex, OpenCode y Antigravity figuran offline (`sin_entrega_automatica`) aunque tengan el chat abierto |
