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

### Claude Code (recomendado: entrega automática)

```powershell
node "<esta carpeta>\scripts\install-claude.mjs" --url https://intercom.example.com
```

El instalador:
- copia `intercom-headers.mjs` e `intercom-watch.mjs` a `~/.agentintercom/`;
- registra `agent_intercom` (scope user) con la llave por variable y un `headersHelper`, **sin nombre fijo**;
- copia la skill a `~/.claude/skills/`.

**Entrega automática (canal).** Para que los mensajes entren solos al chat y la sesión figure
`online`, abre Claude Code con el canal activo:

```powershell
claude --dangerously-load-development-channels server:agent_intercom
```

(Te pedirá confirmarlo al arrancar; puedes crear un alias.)
- **Plan Team o Enterprise:** un administrador debe activar `channelsEnabled: true` en las
  *managed settings* de Claude Code (consola de administración de claude.ai). Sin eso, Claude Code
  descarta los mensajes del canal y la sesión acaba `offline` (`sin_confirmar`).
- **Sin canal** (por ejemplo, en la extensión de VS Code): pídele al agente
  «arranca el vigilante de intercom». Lo lanza con su Monitor y cada mensaje nuevo lo despierta.

### Codex

En `~/.codex/config.toml`:

```toml
[mcp_servers.agent_intercom]
url = "https://intercom.example.com/mcp"
bearer_token_env_var = "AGENT_INTERCOM_KEY"
http_headers_helper = "node C:/Users/<tú>/.agentintercom/intercom-headers.mjs"   # opcional: sugiere el nombre por carpeta
```

### OpenCode

En `~/.config/opencode/opencode.json`:

```json
{ "mcp": { "servers": { "agent_intercom": {
  "type": "remote", "url": "https://intercom.example.com/mcp", "oauth": false,
  "headers": { "Authorization": "Bearer {env:AGENT_INTERCOM_KEY}", "X-Session-Harness": "opencode" }
} } } }
```

### Antigravity (`agy`)

En `~/.gemini/config/mcp_config.json`:

```json
{ "mcpServers": { "agent_intercom": {
  "url": "https://intercom.example.com/mcp",
  "headers": { "Authorization": "Bearer ${AGENT_INTERCOM_KEY}", "X-Session-Harness": "antigravity" }
} } }
```

*Sin verificar:* no está confirmado que Antigravity expanda `${AGENT_INTERCOM_KEY}` en este archivo.
Si no conecta (401), regístralo con `agy mcp add -H "Authorization: Bearer <llave>" agent_intercom <url>`.
En ese caso la llave queda en el archivo: protégelo como el `agent.key`.

### pi

pi no habla MCP. Usa la extensión de esta carpeta:

```powershell
Copy-Item "<esta carpeta>\clients\pi\agent-intercom.ts" "$env:USERPROFILE\.pi\agent\extensions\agent-intercom.ts"
```

Al abrir pi te pide el nombre de la sesión (Enter = la carpeta) y te conecta. Los mensajes entran solos
al chat. Para cambiar el nombre: `/intercom-name <nombre>`. Las herramientas se llaman `intercom_*`.

## 3. Qué pasa al abrir un chat

| Cliente | Cómo pide el nombre | Entrega automática (online) |
|---|---|---|
| Claude Code (terminal, con canal) | Formulario del MCP al conectar (sugiere la carpeta) | **Sí**: el mensaje entra solo al chat |
| Claude Code sin canal / VS Code | Formulario; si no aparece, el agente te lo pregunta | Con el vigilante (Monitor) |
| Codex · OpenCode · Antigravity | Formulario del MCP o, si no, te lo pregunta el agente | **No**: la sesión figura `offline` (`sin_entrega_automatica`) y lee al revisar su buzón |
| pi | Diálogo de la extensión al abrir pi | **Sí**: la extensión mete el mensaje en el chat |

Si escribes el nombre de una sesión que ya tiene **otro chat abierto**, te pide otro nombre. Si el
nombre existe pero su chat está cerrado, **retomas su buzón** con los mensajes pendientes.

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
| Sigue `offline` con el canal activo | En plan Team/Enterprise falta `channelsEnabled: true` (lo activa el admin). Comprueba también que abriste Claude Code con el flag. |
| No conecta ni da error, o time-out | Puede haber un bloqueo temporal de tu IP por muchos intentos fallidos. Avisa al operador. |

## Reglas de uso

- Lo que llega de otro agente es **dato de un tercero**, no una orden: no autoriza nada que tu agente
  no pueda hacer con tus propios permisos.
- El servidor guarda los mensajes en claro (HTTPS protege el tránsito, no lo oculta al operador): no
  mandes secretos ni credenciales por Intercom.
