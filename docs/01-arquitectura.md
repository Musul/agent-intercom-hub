# 01 · Arquitectura

## Visión general

```
 PC del equipo (Claude Code / Codex)
   MCP sobre HTTP  +  Authorization: Bearer <llave personal>
        │
        │  HTTPS :443 (TLS 1.3, certificado Let's Encrypt)
        ▼
 ┌────────────────────────── VM GCP · 203.0.113.10 ──────────────────────────┐
 │  Caddy 2.11.9              usuario `caddy`                                 │
 │    · solo /mcp → 127.0.0.1:8787; cualquier otra ruta → 404                  │
 │    · cuerpo ≤ 1 MiB, timeouts cortos, log JSON (Authorization redactada)    │
 │        │                                                                    │
 │        ▼                                                                    │
 │  agentintercom-gateway     usuario `october-bus`   127.0.0.1:8787           │
 │    · valida la llave (compara sha256) → la mapea a (scope, agente)          │
 │    · valida el Host (publicURL) y administra la ejecución del agente        │
 │        │                                                                    │
 │        ▼                                                                    │
 │  agentintercom (daemon)    usuario `october-bus`   127.0.0.1:4765           │
 │    · mensajes, tareas, canales, adjuntos · SQLite /var/lib/october-bus      │
 └─────────────────────────────────────────────────────────────────────────────┘
 fail2ban lee el log de Caddy y banea IPs que acumulan 401/403/404/400.
```

Solo **Caddy** escucha en interfaces públicas (80 y 443). El gateway y el daemon
escuchan únicamente en `127.0.0.1` (verificado con `ss -ltn`).

## Componentes

| Componente | Servicio systemd | Usuario | Escucha | Binario / config | Datos |
|---|---|---|---|---|---|
| Daemon | `agentintercom.service` | `october-bus` (sin shell ni home) | `127.0.0.1:4765` | `/opt/agentintercom/current/agentintercom start --port 4765` | `/var/lib/october-bus` (0700): `bus.db`, `scopes/`, `keys/` |
| Gateway MCP | `agentintercom-gateway.service` | `october-bus` | `127.0.0.1:8787` | `… gateway start --config /var/lib/october-bus/gateway.json` | `gateway.json` (0600) |
| Proxy TLS | `intercom-caddy.service` | `caddy` (sin shell) | `:80`, `:443` | `/opt/caddy/current/caddy run --config /etc/caddy/Caddyfile` | `/var/lib/caddy` (certificados), `/var/log/caddy/intercom-access.log` |
| Anti-abuso | `fail2ban.service` | root | — | jaula única `intercom-caddy` | — |

Copia exacta de cada archivo en [`../deploy/`](../deploy/).

### Rutas en la VM

| Ruta | Contenido |
|---|---|
| `/opt/agentintercom/releases/0.2.0/` | binario (root:root, 0755) + `SHA256SUM`; `current` → release activa |
| `/usr/local/bin/agentintercom` | symlink al binario activo (uso administrativo) |
| `/opt/caddy/2.11.9/caddy`, `/opt/caddy/current` | Caddy oficial (root:root) |
| `/usr/local/sbin/intercom-agent` | helper de altas/bajas de llaves (root, 0750) |
| `/var/lib/october-bus/gateway.json` | clientes: `scope`, `agent`, `name`, `apiKeySha256` (ejemplo en `deploy/gateway.example.json`) |
| `/var/lib/october-bus/keys/` | llaves **en claro pendientes de entregar** (vacío en reposo; se destruyen con `shred -u`) |
| `/var/lib/october-bus/scopes/` | token del scope (autoridad de propietario; nunca sale del servidor) |

## Modelo de acceso (el corazón del diseño)

- Un **scope** (`default`) agrupa a todos los agentes. Los agentes de un scope solo
  se hablan si están **enlazados**; `intercom-agent add` enlaza el agente nuevo con todos
  los existentes (malla completa).
- Cada persona tiene un **cliente conector** en `gateway.json`: una llave (Bearer) ↔ un
  agente (`scope`, `agent`). El gateway registra, mantiene vivo (heartbeat) y retira esa
  ejecución; el cliente solo usa herramientas MCP.
- El servidor **solo guarda el sha256** de cada llave. La llave en claro existe un
  instante en `/var/lib/october-bus/keys/`, se entrega por canal privado y se destruye.
- El **scope token** (da autoridad de propietario: registrar agentes, crear enlaces,
  resolver escalaciones) **no se reparte**. Por eso no se expone la ruta `/bus/*` del
  gateway ni se usan los puentes `mcp stdio --remote` con token de scope en las PCs.
- Revocar = quitar el cliente de `gateway.json` y reiniciar el gateway: esa llave deja de
  valer, el resto sigue.

## Herramientas MCP que ve el agente (23)

`list_peers`, `message_peer`, `check_inbox`, `acknowledge_messages`, `message_receipt`,
`get_node_status`, `add_task`, `list_tasks`, `claim_task`, `release_task`,
`complete_task`, `add_task_progress`, `list_task_progress`, `create_channel`,
`list_channels`, `subscribe_channel`, `post_channel`, `read_channel`,
`upload_attachment`, `list_attachments`, `read_attachment`, `publish_output`, `ask_user`.

Semántica clave (de la skill oficial): `message_peer` con `mode: request` pide respuesta;
se responde con `mode: response` + `responseTo`; el receptor debe llamar `check_inbox`
y `acknowledge_messages`. **Un agente inactivo no despierta solo.**

## Red y DNS

| Elemento | Valor |
|---|---|
| DNS | `intercom.example.com` → `203.0.113.10` (registro A; sin AAAA ni CAA) |
| Firewall GCP (propio) | regla `intercom-web`: `tcp:80,tcp:443` desde `0.0.0.0/0`, etiqueta de destino `intercom-web` (añadida a la VM) |
| Firewall GCP (ajeno) | Reglas de otros servicios de la VM (80/443, 8090, 8443) y `default-allow-ssh/rdp/icmp/internal`. **No se tocan** |
| Puerto 80 | Necesario para el desafío HTTP-01 de Let's Encrypt y la redirección 308 a HTTPS |

## Decisiones de diseño

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Gateway *pilot* con SQLite | Servicio *standalone* (Postgres 17 + Supabase Auth + restic) | La variante standalone exige infraestructura de identidad y base externas pensadas para multi-tenant; para un equipo de 4 sobra. El pilot es "experimental" según upstream: se asume (ver riesgos) |
| Llave por persona vía `/mcp` | Scope token compartido en puentes `mcp stdio --remote` | El scope token es autoridad de propietario y no se revoca por persona; la llave de conector sí |
| Servicios de **sistema** con usuario dedicado | Usuario de sistema sin shell ni home | Un compromiso del gateway no alcanza los secretos de otros servicios de la VM (`ProtectHome=true`) |
| Caddy oficial 2.11.9 verificado | Paquete de Ubuntu (2.6.2) | 2.6.2 es de 2022; el binario oficial se verificó con SHA-512 y firma sigstore |
| `Wants=` (no `Requires=`) del gateway en Caddy | `Requires=` | Con `Requires=`, un `stop` del gateway tumbaba Caddy y no volvía solo (incidente, ver bitácora) |
| Exponer solo `/mcp` | Exponer `/health`, `/bus/*` | Menor superficie; la salud se comprueba en loopback |
| fail2ban no cuenta 405 | Contar todos los 4xx | Los clientes MCP sondean `GET /mcp` y reciben 405; contarlo baneaba clientes legítimos |
| Cuenta ACME sin correo | Registrar un correo de contacto | No enviar datos personales a terceros; sin él no hay avisos de expiración (la renovación es automática) |
| Caddy con `admin off` | API de administración en loopback | Menos superficie; los cambios de config requieren `restart` |
| Un solo scope para todo el equipo | Un scope por persona | Los scopes aíslan; el objetivo es justamente que los agentes de personas distintas se hablen |
