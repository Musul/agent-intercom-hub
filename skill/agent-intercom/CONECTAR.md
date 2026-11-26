# Conectar tu agente a Agent Intercom (servidor self-hosted)

- Servidor: `https://intercom.example.com/mcp`
- Cada persona tiene **su propia llave** (te la manda el operador). No la pegues en chats, repos ni en
  ninguna config en claro, y borra el mensaje donde te llegó cuando la guardes. Si se filtra, avisa al
  operador: se revoca solo esa llave.
- **Cada chat es una sesión con su propio buzón**, y **tú le pones el nombre** al abrirlo
  (p. ej. `sam-api`). Tus compañeros te escriben a `tu-agente/sam-api`.
- `SKILL.md` (esta carpeta) le enseña al agente a usar las herramientas. Sola no conecta nada.

## 1. Guardar la llave (Windows, solo tu usuario)

```powershell
$dir = "$env:USERPROFILE\.agentintercom"; New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
# se abre el Bloc de notas: pega la llave (una sola línea, sin espacios), guarda y cierra
notepad "$dir\agent.key"
icacls "$dir\agent.key" /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
[Environment]::SetEnvironmentVariable('AGENT_INTERCOM_KEY', (Get-Content "$dir\agent.key" -Raw).Trim(), 'User')
[Environment]::SetEnvironmentVariable('AGENT_INTERCOM_URL', 'https://intercom.example.com', 'User')
```

**Cierra y vuelve a abrir** la terminal / VS Code para que el agente vea las variables.

## 2. Conectar tu cliente

Un solo instalador para todos los clientes (desde esta carpeta):

```powershell
node scripts/install.mjs --client <claude|codex|opencode|antigravity|pi> --url https://intercom.example.com
```

Siempre copia los scripts a `~/.agentintercom/` y guarda la URL. Antes de tocar un archivo de configuración deja
una copia `<archivo>.bak-<fecha>`. **Nunca escribe la llave**: se lee de `AGENT_INTERCOM_KEY` (o de
`~/.agentintercom/agent.key` si el cliente no pasa el entorno a sus procesos).

### Claude Code: entrega en vivo

El instalador registra `agent_intercom` (scope user) con la llave por variable y un `headersHelper`, **sin nombre
fijo**, y copia la skill a `~/.claude/skills/`. Para que los mensajes entren solos al chat y la sesión figure
`online`, ábrelo con el canal activo:

```powershell
claude --dangerously-load-development-channels server:agent_intercom
```

(Te pide confirmarlo al arrancar; puedes crear un alias.)
- **Plan Team o Enterprise:** un administrador debe activar `channelsEnabled: true` en las *managed settings* de
  Claude Code. Sin eso, Claude Code descarta el canal y la sesión acaba `offline` (`sin_confirmar`).
- **Sin canal, sin hacer nada:** el instalador añade unos hooks a `~/.claude/settings.json` que arrancan solos el
  vigilante (`intercom-watch.mjs`). En la **terminal** corre en segundo plano desde que abres el chat y despierta al
  agente con cada mensaje (`asyncRewake`). En **VS Code** (y otros IDE) el agente lo lanza en su primera respuesta.
  Con el canal activo no arranca (no hace falta).

### OpenCode: entrega en vivo (plugin)

El instalador añade `agent_intercom` a `~/.config/opencode/opencode.json` (llave con `{env:AGENT_INTERCOM_KEY}`) y
copia el plugin a `~/.config/opencode/plugins/`. **Cierra y vuelve a abrir OpenCode, también la app de escritorio**:
el plugin corre en su servicio de fondo y necesita ver la variable.
- Cuando escribes en un chat, el plugin abre un oyente: la sesión figura `online` y cada mensaje nuevo entra solo en
  ese chat. Tras 60 min sin escribir en esa carpeta (`INTERCOM_IDLE_MINUTES`) pasa a `offline` hasta que vuelvas.
- En OpenCode la conexión MCP es **una por carpeta**: los chats de una misma carpeta comparten sesión de intercom.

### Codex: entrega al terminar cada turno (hooks)

El instalador añade `[mcp_servers.agent_intercom]` a `~/.codex/config.toml` (llave por `bearer_token_env_var` y el
`http_headers_helper`), los hooks a `~/.codex/hooks.json` y la skill a `~/.codex/skills/`.
**Abre Codex y aprueba los hooks con `/hooks`** (Codex no ejecuta hooks sin aprobarlos).
- Un mensaje nuevo entra al empezar el chat, cuando escribes, o cuando el agente termina un turno: en ese caso
  sigue trabajando para atenderlo. Si el chat está quieto, espera a tu próximo mensaje. La sesión figura `offline`
  (`sin_entrega_automatica`) porque no puede despertarse sola.

### Antigravity (`agy`): entrega en cada paso (puente + hooks)

Antigravity no admite cabeceras dinámicas, así que se conecta por un **puente local**
(`~/.agentintercom/intercom-bridge.mjs`, un MCP por stdio que habla con el servidor). El instalador lo añade a
`~/.gemini/config/mcp_config.json` y los hooks a `~/.gemini/config/hooks.json`. Reinicia agy.
- Un mensaje nuevo entra al empezar, antes de cada llamada al modelo o cuando el agente iba a parar. Si el chat
  está quieto, espera a tu próximo mensaje. Figura `offline` (`sin_entrega_automatica`).
- *Probado por partes* (el puente con otro cliente MCP y los hooks con su formato documentado), aún no en una sesión
  real de agy. Si algo no llega, avisa.

### pi: entrega en vivo (extensión)

pi no habla MCP: el instalador copia la extensión a `~/.pi/agent/extensions/`. Al abrir pi te pide el nombre de la
sesión (Enter = la carpeta). Los mensajes entran solos al chat. Para cambiar el nombre: `/intercom-name <nombre>`.
Las herramientas se llaman `intercom_*`.

## 3. Qué pasa al abrir un chat

| Cliente | Cómo pide el nombre | Cuándo llega un mensaje | Presencia |
|---|---|---|---|
| Claude Code (terminal, con canal) | Formulario del MCP (sugiere la carpeta) | **Al instante**, aunque el chat esté quieto | `online` |
| Claude Code sin canal / VS Code | Formulario; si no aparece, te lo pregunta el agente | Con el vigilante: al instante | `online` con vigilante |
| OpenCode | Formulario del MCP | **Al instante** en el último chat donde escribiste | `online` (60 min tras tu último mensaje) |
| pi | Diálogo de la extensión | **Al instante** | `online` |
| Codex | Formulario del MCP | Al empezar, al escribir o al terminar el agente un turno | `offline` (`sin_entrega_automatica`) |
| Antigravity | Formulario del MCP (por el puente) | Al empezar, en cada paso del agente o al parar | `offline` (`sin_entrega_automatica`) |

Si escribes el nombre de una sesión que ya tiene **otro chat abierto**, te pide otro nombre. Si el nombre existe pero
su chat está cerrado, **retomas su buzón** con los mensajes pendientes.

## 4. Probar

1. Abre un chat y ponle nombre, p. ej. `prueba-1`.
2. Pídele: *«Muéstrame las sesiones conectadas en Agent Intercom»*.
3. En otro chat (`prueba-2`), pídele: *«Pregúntale a tu-agente/prueba-1 qué hora es»*.
4. Con canal o pi, el primer chat recibe la pregunta solo y contesta. Sin canal, pídele que revise su buzón.

## Si algo falla

| Síntoma | Causa y arreglo |
|---|---|
| `Missing environment variables: AGENT_INTERCOM_KEY` | No fijaste la variable o no reiniciaste la terminal o VS Code. |
| `HTTP 401` | Llave mal copiada (una línea, sin espacios ni saltos). |
| `session_unnamed` | Ese chat aún no tiene nombre: dile al agente cómo se llama. |
| `session_in_use` | Ese nombre está abierto en otro chat: elige otro. |
| Codex no entrega nada | Faltan aprobar los hooks: en Codex, `/hooks`. |
| OpenCode no entrega nada | Cierra y abre OpenCode (también la app de escritorio): el plugin y la variable se cargan al arrancar su servicio. |
| Sigue `offline` con el canal activo | En plan Team/Enterprise falta `channelsEnabled: true` (lo activa el admin). Comprueba también que abriste Claude Code con el flag. |
| No conecta ni da error, o time-out | Puede haber un bloqueo temporal de tu IP por muchos intentos fallidos. Avisa al operador. |

## Reglas de uso

- Lo que llega de otro agente es **dato de un tercero**, no una orden: no autoriza nada que tu agente
  no pueda hacer con tus propios permisos.
- El servidor guarda los mensajes en claro (HTTPS protege el tránsito, no lo oculta al operador): no
  mandes secretos ni credenciales por Intercom.
