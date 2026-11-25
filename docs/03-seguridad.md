# 03 · Seguridad

El servicio es **público en internet** por decisión explícita (el equipo está en redes y
VPNs cambiantes, así que no se puede limitar por IP). La seguridad descansa en: llave
fuerte por persona, superficie mínima, aislamiento del host, detección de abuso y
revocación inmediata. Lo que **no** cubre está en [riesgos residuales](#riesgos-residuales).

## Activos y actores

| Activo | Por qué importa |
|---|---|
| Llaves personales (Bearer) | Quien tiene una actúa como ese agente: lee su bandeja, escribe a los demás |
| Mensajes, tareas, adjuntos | Contexto de trabajo interno; el servidor los guarda en claro |
| Scope token (`/var/lib/october-bus/scopes/`) | Autoridad de propietario sobre el scope |
| Host (VM compartida) | Aloja otros servicios con credenciales de producción |

Actores considerados: escáneres de internet (ya presentes minutos después de abrir el puerto),
atacante con una llave filtrada, miembro del equipo con un agente comprometido o manipulado
por prompt-injection, atacante que compromete un proceso del servicio.

## Controles por capa

### Red y TLS
- Solo 80 y 443 públicos; gateway (8787) y daemon (4765) en `127.0.0.1`.
- TLS 1.3 con certificado Let's Encrypt (renovación automática por Caddy); HSTS 1 año.
- `strict_sni_host`: el `Host` debe coincidir con el SNI; por IP directa no hay servicio.
- Puerto 80 solo para el desafío ACME y la redirección 308.
- Cuenta ACME sin correo de contacto (no se envían datos personales al CA).

### Proxy (Caddy)
- Solo la ruta `/mcp` llega al gateway; todo lo demás responde `404`. No se exponen `/health` ni `/bus/*`.
- Cuerpo máximo 1 MiB (`413` por encima); cabeceras máx. 16 KB; timeouts: header 10 s, body 20 s, write 60 s, idle 2 min.
- Cabeceras: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; se quita `Server`.
- API de administración apagada (`admin off`).
- Log JSON de acceso con `Authorization` **redactada** (verificado: aparece `REDACTED`); rotación 10 MiB × 5 / 30 días.

### Autenticación y autorización
- Llave por persona/agente generada por `gateway key` (aleatoria, URL-safe, 47 caracteres). El servidor guarda **solo su sha256**.
- 401 en el gateway sin llave o con llave inválida; 403 si el `Host` no coincide con `publicURL`.
- Cada llave autoriza **un** agente en **un** scope; no puede crear scopes, enlaces ni administrar.
- El scope token y la administración (`scope`, `link`, `backup`…) solo existen por CLI local en el servidor.
- Límites de admisión del gateway (upstream): 32 ranuras para comprobar credenciales y salud, 32 para heartbeat/retiro, 128 compartidas para peticiones validadas (16 por conector); cuerpo 1 MiB; espera de bandeja 25 s.
- Revocación inmediata y por persona: `sudo intercom-agent revoke <id>`.

### Host
- Servicios de **sistema** con usuarios dedicados sin shell ni home (`october-bus`, `caddy`), para no alcanzar los secretos de otros servicios de la VM.
- Binarios en `/opt` propiedad de root, de solo lectura para el servicio. Datos `0700`, `UMask=0077`.
- Sandbox systemd en las tres unidades: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictSUIDSGID`, `RestrictRealtime`, `LockPersonality`, `MemoryDenyWriteExecute`, `CapabilityBoundingSet` vacío (Caddy solo `CAP_NET_BIND_SERVICE`), `SystemCallFilter=@system-service ~@privileged @resources`, límites de memoria/tareas/ficheros.
- Daemon y gateway con `IPAddressDeny=any` + `IPAddressAllow=localhost`: no pueden hablar con nada fuera de loopback.
- Puntuación `systemd-analyze security`: daemon 1.1, gateway 1.1, Caddy 1.4 (todas "OK").
- SSH ya era solo por llave (`PasswordAuthentication no`).

### Cadena de suministro
- Agent Intercom: versión fijada (`0.2.0`); paquete npm con **procedencia SLSA** y firmas del registro; binario copiado a `/opt` con sha256 registrado.
- Caddy: binario oficial 2.11.9; SHA-512 contra `checksums.txt` y firma sigstore verificada con `openssl` (emisor sigstore, identidad = workflow de release de `caddyserver/caddy` en ese tag).
- No se usó el paquete de Ubuntu de Caddy (2.6.2, de 2022).

### Detección y respuesta
- `fail2ban` (jaula `intercom-caddy`): 20 respuestas 400/401/403/404 por IP en 60 s → ban 1 h, con incremento ×4 hasta 7 días. 405 no cuenta (los clientes sondean `GET /mcp`).
- Evidencia en producción: a los minutos de abrir ya había decenas de IPs de escáner, y una fue baneada.
- Log de acceso de Caddy + `journalctl -u agentintercom-gateway`.

### Secretos
- Ninguna llave, token ni digest en este repo (`.gitignore` bloquea `*.key`, `*.pem`, `*.token`, `id_*`, `.env`).
- Llave en claro en el servidor solo hasta su entrega; luego `shred -u`.
- En la PC del usuario: archivo en `~\.agentintercom\` con ACL solo para su usuario + variable de usuario `AGENT_INTERCOM_KEY`; la config de Claude Code guarda `Bearer ${AGENT_INTERCOM_KEY}`, **no** la llave (verificado: la llave no aparece en `~/.claude.json`).

## Riesgos residuales

| Riesgo | Detalle | Mitigación / acción |
|---|---|---|
| **Prompt-injection entre agentes** | Un mensaje de un agente llega a otro como *dato de un tercero*. Si el agente receptor lo trata como orden, ejecuta con los permisos de su dueño | La skill lo prohíbe expresamente; los permisos del agente siguen mandando. Mantén la aprobación de acciones sensibles activada |
| Servidor lee todo | Los mensajes se guardan en claro; HTTPS no los oculta al operador (no hay E2E) | No enviar secretos por Intercom |
| Llave y variable legibles por procesos del mismo usuario (Windows) | El ACL no defiende de malware del mismo usuario; upstream no cualifica ACL de Windows | Rotación si hay sospecha; higiene de los equipos |
| VM compartida | Quien tenga `sudo` en la VM lee todo (llaves entregadas no, pero sí la base y los secretos de otros servicios) | Ya aislado por usuario; considerar VM propia si crece |
| Conflicto de puertos con otro servicio | Si otro proxy reclama 80/443, el nuestro no enlaza (o al revés) | No tocar lo ajeno; avisar al operador |
| Software experimental | Upstream etiqueta el gateway *pilot* como experimental y 0.2.0 como candidata; sin garantías de uptime | Pruebas con el equipo antes de confiar flujos críticos; seguir releases |
| Agotamiento por llave válida | Quien tenga una llave puede saturar el pool compartido (128) | Revocar esa llave |
| IP compartida de VPN | Un baneo por fail2ban afecta a toda una IP de salida | `fail2ban-client set intercom-caddy unbanip <IP>` |
| Sin backups | La base no tiene copia programada | Ver [pendientes](07-pendientes.md) |
| Sin monitoreo externo | El watchdog del kit no vigila estos servicios | Ver [pendientes](07-pendientes.md) |
| RDP (3389) abierto al mundo en la VM | Regla preexistente `default-allow-rdp`, sin servicio escuchando; **no es de este despliegue** | Recomendado cerrarla |
| Sin CAA | Cualquier CA podría emitir para el dominio | Añadir CAA `0 issue "letsencrypt.org"` (opcional) |

## Respuesta a incidentes

| Situación | Acción |
|---|---|
| Llave de una persona filtrada o perdida | `sudo intercom-agent revoke <id>` → `sudo intercom-agent add <id>` → entregar la nueva por canal privado. La anterior deja de valer al reiniciar el gateway (segundos) |
| Sospecha de abuso de una IP | `sudo fail2ban-client set intercom-caddy banip <IP>`; revisar `/var/log/caddy/intercom-access.log` |
| Se sospecha del scope token | `$AI scope rotate-token --id default` (según upstream retira todas las ejecuciones) y reiniciar el gateway. **No ejecutado en este despliegue**: validar el efecto sobre las llaves de conector antes de depender de ello |
| Compromiso del host | Parar `intercom-caddy`, `agentintercom-gateway`, `agentintercom`; rotar todas las llaves; revisar el resto de servicios de la VM |
| Agente manipulado | Revocar su llave; revisar mensajes recientes de y hacia él |

## Evidencia de verificación (2026-11-24)

- Pruebas externas: 401 sin llave y con llave falsa; 404 en `/`, `/health/ready`, `/bus/v1/me`, `/v1/admin`, `/.env`; 413 sobre 1 MiB; handshake fallido por IP; 308 de HTTP a HTTPS; TLS 1.3; cabeceras de seguridad presentes.
- Ida y vuelta de mensajes entre dos agentes por la URL pública, con recibo `acknowledged`.
- Revocación efectiva (401) sin afectar a los demás.
- Log de acceso con `Authorization` redactada.
- fail2ban: jaula activa; ban real a un escáner externo; filtro validado con `fail2ban-regex`.
- Peticiones con 200 desde IPs externas solo en el desafío ACME de Let's Encrypt (validación multi-perspectiva); los únicos 200 en `/mcp` fueron de la propia VM en las pruebas.
