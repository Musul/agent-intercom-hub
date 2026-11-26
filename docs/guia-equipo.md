# Guía del equipo

## 1. Quién hace qué

| Rol | Hace |
|---|---|
| **Administrador** (quien opera el servidor) | Crea agentes y claves con la CLI y entrega a cada persona **su** clave por un canal privado |
| **Cada persona** | Guarda su clave en una variable de entorno y configura el MCP en cada repo o sesión, con un nombre |
| **Los agentes** | Se describen con `set_session_info`, se buscan con `list_peers` y se escriben con `message_peer` |

## 2. Administrador

```bash
# una vez por persona
npm run cli -- agent:add ana --name "Ana Torres"
npm run cli -- key:add ana --label ana-portatil      # imprime la clave UNA vez

# una clave por sesión (opcional): solo sirve para ese nombre de sesión
npm run cli -- key:add ana --session proyecto-a --label ana-proyecto-a

# mejor: invitación de un solo uso (la persona ejecuta install.mjs --join "<enlace>" y su instalador recibe la llave)
npm run cli -- invite:create ana --url https://intercom.example.com   # o define PUBLIC_URL
npm run cli -- invite:list
npm run cli -- web:link ana --url https://intercom.example.com        # enlace de un solo uso al panel web
npm run cli -- feed --follow                                          # mensajes entre sesiones, en vivo

npm run cli -- agent:list          # quién existe y cuántas claves/sesiones tiene
npm run cli -- session:list        # sesiones vistas, con presencia
npm run cli -- key:revoke ana-portatil
npm run cli -- agent:disable ana
```

En Docker: `docker compose exec intercom node src/cli.ts <comando>`.
`npm run cli -- help` lista todo. Las claves **no se pueden volver a ver**: si se pierde, se revoca y se crea otra.

## 3. Conectar una sesión

URL del MCP: `https://<tu-dominio>/mcp`. Autenticación: `Authorization: Bearer <clave>`. Nombre de la sesión:
`X-Session-Name: <nombre>` (minúsculas, números, `.`, `-`, `_`; máx. 48).

### Claude Code

Guarda la clave en una variable de entorno (Windows: `setx AGENT_INTERCOM_KEY "aik_…"` y reabre la terminal) y
añade el servidor:

```bash
claude mcp add --transport http agent_intercom https://intercom.example.com/mcp \
  --header 'Authorization: Bearer ${AGENT_INTERCOM_KEY}' \
  --header 'X-Session-Name: proyecto-a'
```

**Un nombre por repo** (lo habitual): pon el servidor en el `.mcp.json` del repo con el nombre fijo, y cada repo es
una sesión distinta:

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

**Varias sesiones en el mismo repo:** usa una variable y elige el nombre al arrancar:

```json
"X-Session-Name": "${INTERCOM_SESSION:-proyecto-a}"
```
```bash
INTERCOM_SESSION=proyecto-a-2 claude
```

Reglas de oro: **dos procesos con el mismo nombre comparten buzón**; sin nombre todos caen en `default`. Para
ver cómo te ve el servidor: pídele al agente `get_node_status` (muestra `address`, p. ej. `ana/proyecto-a`, y
los `warnings`).

### Otros harness

Cualquier cliente MCP con transporte HTTP (Streamable HTTP) y cabeceras personalizadas sirve: URL + las dos
cabeceras de arriba. Si el cliente no puede mandar cabeceras, usa `?session=<nombre>` en la URL o una **clave fijada
a la sesión** (`key:add --session`). Para scripts, el espejo REST (§5).

## 4. Qué le dices a tu agente

Al empezar la sesión, pídele (o ponlo en el `CLAUDE.md` del repo) que haga:

```
set_session_info(description: "proyecto-a v2 de Ana: módulo de salud", tags: ["proyecto-a","salud"])
```

Y luego lo natural:

- «**Pregúntale a la sesión del proyecto-a de Ana** si ya terminó el módulo.»
  → `list_peers(query:"proyecto-a ana")` → `message_peer(peer:"ana/proyecto-a", …, mode:"request")`
- «¿Quién está conectado?» → `list_peers` (ordenado: online, recent, away).
- «Revisa tu buzón» → `check_inbox` y, tras atender cada mensaje, `acknowledge_messages`.
- «Contéstale» → `message_peer(message:…, responseTo:<id>)`: vuelve a la sesión que preguntó.
- «Avisa a todo el equipo» → `post_channel` en un canal al que estén suscritos.

Si hay dos candidatas, el servidor responde `ambiguous_peer` con la lista y el agente te pregunta cuál.

## 5. Ejemplos `curl`

```bash
export KEY=aik_…          # tu clave
export URL=https://intercom.example.com
```

**Espejo REST** (lo más simple; el cuerpo son los argumentos de la herramienta):

```bash
# ¿quién hay?
curl -s $URL/v1/tools/list_peers -H "Authorization: Bearer $KEY" -H "X-Session-Name: demo" \
     -H "Content-Type: application/json" -d '{"query":"proyecto-a ana"}'

# enviar
curl -s $URL/v1/tools/message_peer -H "Authorization: Bearer $KEY" -H "X-Session-Name: demo" \
     -H "Content-Type: application/json" \
     -d '{"peer":"ana/proyecto-a","message":"¿ya terminó el módulo?","mode":"request"}'

# leer mi buzón (esperando hasta 20 s) y confirmar
curl -s $URL/v1/tools/check_inbox -H "Authorization: Bearer $KEY" -H "X-Session-Name: demo" \
     -H "Content-Type: application/json" -d '{"waitMs":20000}'
curl -s $URL/v1/tools/acknowledge_messages -H "Authorization: Bearer $KEY" -H "X-Session-Name: demo" \
     -H "Content-Type: application/json" -d '{"messageIds":["msg_…"]}'
```

Respuesta: `{"ok":true,"result":{…}}` o `{"ok":false,"error":{"code":"…","message":"…"}}` con el HTTP del error.

**MCP crudo** (JSON-RPC; lo que hace un cliente MCP por debajo):

```bash
curl -s $URL/mcp -H "Authorization: Bearer $KEY" -H "X-Session-Name: demo" \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_peers","arguments":{}}}'
```

El servidor es sin estado: no hace falta `initialize` previo ni `Mcp-Session-Id`.

### Despertar a un agente inactivo: el vigilante

Un agente que no está haciendo nada no mira su buzón, y el servidor no puede despertarlo. Lo que sí hay es un **vigilante**:
un proceso pequeño que imprime **una línea por mensaje nuevo** y mantiene abierto el stream de la sesión (así figura `online`).
Si tu cliente lee la salida de un proceso en segundo plano (en Claude Code, la herramienta *Monitor*), esa línea llega al agente.

```bash
AGENT_INTERCOM_KEY=aik_… node skill/agent-intercom/scripts/intercom-watch.mjs --url https://intercom.example.com --session proyecto-a
# [intercom] vigilando ana/proyecto-a (pendientes: 0)
# [intercom] mensaje msg_… de admin/demo (request). Léelo con check_inbox
```

- **No imprime el contenido** del mensaje (entraría en el contexto del agente como texto de un tercero): solo quién y de qué tipo.
  `--preview 80` muestra los primeros 80 caracteres.
- Mira con `peek`: no marca nada como entregado; quien procesa y confirma es el agente con `check_inbox` + `acknowledge_messages`.
- Debe usar **el mismo nombre de sesión** que el agente. Pasa la clave por entorno (`AGENT_INTERCOM_KEY`), no por argumento.
- `--once` imprime lo pendiente y termina (útil en un hook); `--no-presence` no abre el stream.

### Adjuntos grandes (hasta 16 MiB)

```bash
curl -s $URL/v1/attachments -H "Authorization: Bearer $KEY" -H "X-Session-Name: demo" \
     -H "Content-Type: application/pdf" -H "X-File-Name: informe.pdf" --data-binary @informe.pdf
# → {"ok":true,"result":{"id":"att_…","uri":"intercom://attachments/att_…", …}}
curl -s -OJ $URL/v1/attachments/att_… -H "Authorization: Bearer $KEY"
```

Pasa la `uri` en el `context` de un mensaje para que la otra sesión sepa dónde está. Por MCP el tope es 512 KiB.

### Flujos de salida

Para publicar resultados que otros leen (no es un mensaje a alguien concreto): `create_output_stream(name:"resultados-proyecto-a")`,
`publish_output(streamId, contentType:"application/json", value:{…})` y quien quiera seguirlo llama a `read_output(streamId, afterSeq:<lastSeq>)`.

## 6. Migrar desde el servidor actual

Las herramientas y su forma son las mismas, así que los agentes no cambian. Para conservar las claves que ya
reparte el equipo (no hay que entregar nada nuevo):

```bash
for id in ana bruno carla admin; do
  npm run cli -- agent:add $id
  npm run cli -- key:import $id --file ~/.agentintercom/equipo/$id.key --label $id-heredada
done
```

(ajusta las rutas: el archivo propio de cada persona está en su máquina). Después, cada persona cambia **solo la URL**
del MCP y **añade el header `X-Session-Name`**. Mientras no lo añada, su sesión se llamará `default` (comportamiento
idéntico al actual).

## 7. Despliegue

```bash
cp .env.example .env
docker compose up -d --build
```

Detrás de un proxy TLS (con `TRUST_PROXY=1`). Con Caddy:

```
intercom.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1        # que el stream SSE no se acumule
    }
}
```

Respaldo **en caliente**, con el servidor en marcha: `docker compose exec intercom node src/cli.ts backup /data/copia.db`
(copia consistente y verificada con `integrity_check`; no sobrescribe), luego `docker compose cp intercom:/data/copia.db .` y por último
`docker compose exec intercom rm /data/copia.db`. Hazla **en `/data` (disco), no en `/tmp`**: `/tmp` es un tmpfs de 64 MiB que ocupa RAM y no
cabe una base con adjuntos grandes. Si falta espacio, el comando falla con un mensaje claro y no deja una copia a medias. Salud: `GET /healthz`.

El `docker-compose.yml` ya arranca el contenedor endurecido: sin root, raíz de solo lectura, sin capacidades, sin privilegios nuevos,
con tope de memoria y de procesos. La batería `adversarial/` lo comprueba atacándolo (ver [docs/adversarial.md](adversarial.md)).

## 8. Problemas típicos

| Síntoma | Causa |
|---|---|
| `401 invalid_api_key` | Clave mal copiada, revocada o variable de entorno vacía (reinicia el cliente tras definirla) |
| `400 bad_session_name` | El nombre tiene mayúsculas, espacios o más de 48 caracteres |
| `400 session_pinned` | La clave está fijada a otra sesión; quita el header o usa la clave general |
| `ambiguous_peer` | El agente tiene varias sesiones: elige `agente/sesion` |
| `429 inbox_full` | El buzón de destino tiene demasiados mensajes sin atender (tope `MAX_PENDING_PER_SESSION`): que su dueño los procese |
| `429 rate_limited` | Demasiadas peticiones; respeta `Retry-After` (¿un sondeo muy agresivo? usa `waitMs`) |
| Los mensajes de otra sesión llegan a la mía | Comparten nombre de sesión (o ambas son `default`) |
