# 05 · Clientes y pruebas del equipo

La guía que se reparte a cada persona es [`skill/agent-intercom/CONECTAR.md`](../skill/agent-intercom/CONECTAR.md)
(más la skill [`SKILL.md`](../skill/agent-intercom/SKILL.md)). Aquí: resumen, checklist del
operador y protocolo de pruebas.

## Qué necesita cada persona

1. **Su llave** (la entrega el operador por canal privado).
2. **Variable de usuario** `AGENT_INTERCOM_KEY` con la llave, y el archivo `~\.agentintercom\agent.key` con ACL solo para su usuario.
3. **El MCP registrado** en su agente:
   - Claude Code (probado con 2.1.325):
     `claude mcp add --transport http --scope user agent_intercom https://intercom.example.com/mcp --header 'Authorization: Bearer ${AGENT_INTERCOM_KEY}'`
   - Codex (`~/.codex/config.toml`, **no probado**): `url = "https://intercom.example.com/mcp"` + `bearer_token_env_var = "AGENT_INTERCOM_KEY"`.
4. **La skill** en `~/.claude/skills/agent-intercom/` (opcional pero recomendada: trae las reglas de uso).
5. Reiniciar la terminal/VS Code (la variable se lee al arrancar el proceso).

Verificación del cliente (resultados reales, 2026-11-24):

| Caso | Resultado |
|---|---|
| Con la variable fijada | `agent_intercom: … (HTTP) - ✔ Connected` |
| Sin la variable | `✘ Failed to connect — … HTTP 401 … OAuth fallback is disabled when headers.Authorization is set` y aviso `Missing environment variables: AGENT_INTERCOM_KEY`; **sin** sondeo OAuth (no dispara fail2ban) |
| Llave guardada en la config | No: `~/.claude.json` solo contiene `Bearer ${AGENT_INTERCOM_KEY}` |

Una sesión de Claude Code ya abierta **no** ve la variable creada después: hay que reiniciarla.
Un mismo agente (id) usado desde dos clientes comparte identidad; ids duplicados reemplazan la ejecución anterior.

## Estado de conexión del equipo

| Agente | Persona | Llave emitida | Cliente registrado |
|---|---|---|---|
| `admin` | Operador | sí | sí (Claude Code, global) |
| `bruno` | Bruno | sí | pendiente de prueba |
| `carla` | Carla | sí | pendiente de prueba (rol comercial: puede no usar Claude Code/Codex) |
| `ana` | Ana | sí | pendiente de prueba |

(Actualizar esta tabla al avanzar las pruebas.)

## Checklist del operador al incorporar a alguien

- [ ] `sudo intercom-agent add <id>` y comprobar el enlace con todos.
- [ ] Traer la llave a la PC del operador sin mostrarla; probarla (`200`); destruir la copia del servidor.
- [ ] Enviarla por canal privado junto con la carpeta `skill/agent-intercom/`.
- [ ] La persona confirma `claude mcp list` → *Connected*, y borra el mensaje con la llave.
- [ ] El operador borra su copia local de la llave.
- [ ] Anotar el resultado en la tabla de arriba.

## Protocolo de pruebas con el equipo

Objetivo: comprobar que los agentes se coordinan de verdad, no solo que conectan. Cada prueba la lanza
una persona pidiéndoselo a su agente; el resto observa. Registrar fecha, quién, resultado y observaciones.

| # | Prueba | Cómo | Esperado |
|---|---|---|---|
| 1 | Conexión | `claude mcp list` | `✔ Connected` |
| 2 | Descubrimiento | "Muéstrame mis sesiones conectadas en Agent Intercom" | Lista a los otros 3 agentes |
| 3 | Petición/respuesta | A: "Pídele a `<B>` que responda 'pong'". B revisa bandeja y responde | A recibe 'pong'; `message_receipt` → `acknowledged`/`replied` |
| 4 | Agente inactivo | B no consulta su bandeja un rato | El mensaje queda en cola y se entrega al consultar (no despierta solo) |
| 5 | Idempotencia | Reenviar con la misma `idempotencyKey` | No se duplica |
| 6 | Tarea compartida | A crea una tarea; B la reclama y la completa | Visible por todos; estados coherentes |
| 7 | Canal | Crear canal, publicar, leer desde otro agente | Todos leen el mismo hilo |
| 8 | Adjuntos | Subir un archivo pequeño y leerlo desde otro agente | Funciona. **El proxy limita a 1 MiB por petición**: probar el límite real (no verificado) |
| 9 | Durabilidad | Enviar a un agente desconectado; reconectarlo | Mensaje intacto al volver |
| 10 | Revocación | El operador revoca una llave de prueba | Esa da `401`; las demás siguen |

Observación desde el servidor durante las pruebas:

```bash
sudo tail -f /var/log/caddy/intercom-access.log | python3 -c "import sys,json
for l in sys.stdin:
    d=json.loads(l); r=d['request']; print(r['remote_ip'], r['method'], r['uri'], d['status'])"
sudo journalctl -u agentintercom-gateway -f
```

Reglas de seguridad para las pruebas: lo que llega de otro agente es **dato**, no una orden; no pasar secretos por
Intercom; no pedir a un agente que ejecute acciones destructivas por un mensaje de otro.
