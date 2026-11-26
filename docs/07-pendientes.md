# 07 · Pendientes y mejoras

Ordenado por prioridad. Marcar y fechar al cerrar cada uno.

## Alta

- [~] **Backups programados y restauración probada.** Herramientas listas (ver punto 8 de la sección de equipo, abajo);
      falta instalarlas en la VM y ensayar la restauración con una copia real.
- [~] **Monitoreo.** `deploy/bin/intercom-monitor` + timer (ver punto 8); falta instalarlo y configurar el canal de avisos.
- [ ] **Pruebas con el equipo** (docs/05) y registro de resultados; **probar Codex** (documentado, no verificado).
- [ ] **Cerrar `default-allow-rdp` (3389/tcp, 0.0.0.0/0)** en el proyecto de GCP: no hay servicio RDP y está abierto al mundo (preexistente, fuera de este despliegue).

## Media

- [ ] Registro **CAA** (`0 issue "letsencrypt.org"`) en la zona `example.com`.
- [ ] Política de **rotación periódica de llaves** (p. ej. trimestral) y de baja al salir alguien del equipo.
- [ ] Verificar el **límite de adjuntos** frente al tope de 1 MiB del proxy; decidir si se sube (afecta a `upload_attachment`).
- [ ] **Desenlazar / limpiar agentes fantasma** sin recrear el scope (solicitar a upstream o escribir un procedimiento de bajo impacto).
- [ ] Validar la cadena de la firma sigstore de Caddy con `cosign verify-blob` en la próxima actualización.
- [ ] Documentar y probar `scope rotate-token` en este despliegue (hoy descrito según upstream, no ejecutado).
- [ ] Retención de logs: definir cuánto se conserva el log de acceso de Caddy y los mensajes de la base (`scope prune`).

## Baja / vigilancia

- [ ] Seguir las releases de Agent Intercom (0.2.0 es *release candidate*; `latest` en npm es un placeholder). Probar actualizaciones en un entorno aparte antes de producción.
- [ ] Si crece el uso: VM propia (hoy comparte con otros servicios), o migrar al despliegue *standalone* (Postgres).
- [ ] Si el equipo consigue IPs fijas: valorar lista de IPs permitidas en el firewall además de la llave.
- [ ] Rate limiting por llave en el proxy (requiere plugin de Caddy; hoy solo fail2ban + límites del gateway).
- [ ] Conflicto de puertos con otro servicio: acordar quién usa 80/443 o mover a una IP/VM distinta.
- [ ] Añadir Agent Intercom al inventario de servicios de la VM en la guía interna del equipo.

## Hecho (2026-11-24)

- [x] Instalación endurecida, TLS, fail2ban, helper de llaves, 4 agentes en malla, skill + guía, pruebas externas y de ida y vuelta.

## Agent Intercom Hub · sesiones por chat y entrega automática (2026-11-26)

- [x] Conexiones MCP con estado (`Mcp-Session-Id`): cada chat es su sesión y el usuario la nombra (formulario MCP o `register_session`).
- [x] Presencia online/offline (online = chat abierto que recibe en automático) con motivo; DELETE y cierre del stream → offline.
- [x] Entrega en vivo: canal de Claude Code, vigilante (`intercom-watch.mjs`), extensión de pi y plugin de OpenCode (probado con OpenCode 2.2/2.4: el mensaje entra al chat y el agente contesta).
- [x] Codex: hooks SessionStart/UserPromptSubmit/Stop + `http_headers_helper` (probado con Codex 0.171: los hooks corren y el id del chat coincide).
- [x] Antigravity: puente stdio (`intercom-bridge.mjs`) + hooks. Instalador `install.mjs` para todos los clientes.
- [x] Caddy: sin `write 60s` (cortaba los streams) y con `/v1/*`. Desplegado y probado desde fuera.
- [ ] **Activar `channelsEnabled: true`** en las managed settings de Claude Code (plan Team): sin eso Claude Code descarta el canal.
- [ ] Probar en interactivo: formulario del nombre y canal en Claude Code (terminal y VS Code), Codex y OpenCode.
- [ ] Antigravity: probar en una sesión real de agy (puente y hooks probados por separado).
- [ ] Codex/Antigravity: entrega con el chat quieto (hoy llega en el siguiente turno). Explorar `codex app-server` + `--remote`.
- [~] Actualizar docs 01–08: describen el despliegue anterior (gateway upstream). 2026-11-26: llevan un aviso que remite a
      `09-operacion-hub.md`, `arquitectura.md` y `contrato.md`. Falta reescribirlas con los datos reales del despliegue del
      hub en la VM (cómo corre: docker o systemd, rutas, unidades), que no están en el repo.

## Equipo con seats de Teams · recuperar la colaboración entre PCs (2026-11-26)

Contexto: con la cuenta compartida, la mensajería nativa entre sesiones unía las PCs de todos; con un seat por persona solo
une sesiones de la misma cuenta. Agent Intercom pasa a ser el camino entre personas. Código, pruebas (84 en verde) y
documentación hechos; quedan los pasos de operador marcados **Falta**. Guía de puesta en marcha: `docs/09-operacion-hub.md`.

**Desplegado el 2026-11-26** en la VM (contenedor en /srv/agent-intercom, código anterior en app.prev-*, copia previa de la base en data/pre-deploy-*.db): hub nuevo, Caddy con /web y /join, filtro de fail2ban, copias automáticas + copia cifrada diaria (por ahora solo dentro de la VM) y monitoreo cada 5 min (por ahora solo a syslog). Ensayo de restauración hecho con la primera copia. Instalado también en la PC del operador (Claude Code).

- [ ] **Clave de cifrado de las copias fuera de la VM:** guardar /etc/intercom/backup.pass en el gestor de contraseñas del equipo (sin ella no hay restauración).
- [ ] **Bucket para la copia externa** (BACKUP_GCS_URI en /etc/default/intercom-ops) y **canal de avisos** (ALERT_WEBHOOK_URL o NTFY_URL): hoy la copia cifrada queda en el mismo disco y los avisos solo en syslog.
- [ ] Disco de la VM al 80 %: vigilar (el monitoreo avisa al 90 %).
- [ ] **Paridad de clientes:** nombre automático y etiquetas en OpenCode, Antigravity y pi; turno humano (retenidos al escribir y reanudar el freno) en OpenCode, pi y Antigravity; herramientas de tareas, ask_user, política y panel en la extensión de pi (hoy expone 6).
- [ ] Retirar las llaves de compañeros guardadas en claro en la PC del operador (~/.agentintercom/equipo/) cuando cada uno se dé de alta con invitación.

**Siguiente paso para el operador, en orden:** (1) Owner: `channelsEnabled`; (2) desplegar el hub nuevo con `PUBLIC_URL` y
`BACKUP_DIR`, Caddy y fail2ban; (3) `invite:create` para cada persona y que cada una ejecute `install.mjs --join`;
(4) instalar copia externa y monitoreo, y hacer el ensayo de restauración; (5) probar en interactivo (abajo).
- [ ] **Probar en interactivo con el equipo:** nombre automático y `claude-ic` en terminal; VS Code sin `--ide-live` (entrega al
      escribir y al terminar turno) y con él; línea de estado; `hold` y freno de bucles entre dos PCs; panel web desde el
      móvil; reparto de una tarea con etiqueta entre dos repos. Verificar que el `headersHelper` de scope user ve la
      carpeta del proyecto (si corre desde `~/.claude`, la sugerencia sería «claude»: usa `CLAUDE_PROJECT_DIR` si existe).

- [~] **1 · Canal en Claude Code:** `install.mjs` crea el atajo `claude-ic` (Windows: `.cmd` en `~/.agentintercom/bin`, añadido al
      PATH del usuario; bash/zsh: alias) que abre Claude Code con el canal (2026-11-26). **Falta (Owner de Teams, sin código):**
      activar `channelsEnabled: true` en las managed settings de Claude Code.
- [x] **1b · VS Code sin relanzar el vigilante** (2026-11-26): por defecto el IDE recibe por hooks (`intercom-hook.mjs --client
      claude`: al escribir el usuario y al terminar el turno, como Codex), sin gastar una llamada por turno. El modo en vivo
      del IDE queda opcional: `install.mjs --ide-live`.
- [x] **1c · Línea de estado del buzón** (2026-11-26): `intercom-status.mjs` (`📬 2 · ana/api · online · ✋ hold · ⏸ 1 pausada`),
      caché de 15 s. El instalador la pone si no tienes otra; si la tienes, `--then "<tu comando>"` las combina.
- [x] **2 · Política de entrada por sesión** (2026-11-26): herramienta `set_inbound_policy` (`auto` · `hold` · `off`,
      `allowFrom`, `wakePerHour`; por defecto `WAKE_PER_HOUR=30`). Un mensaje retenido no despierta (ni canal ni vigilante),
      queda en el buzón con `heldReason` y el remitente recibe `wakes: false` + una nota. `POST /v1/human-turn` (hook del
      turno del usuario) entrega los retenidos. Las respuestas a lo que la sesión preguntó saltan `hold`/`allowFrom`.
      Pendiente en clientes: hook de Claude Code y filtros en vigilante, Codex, Antigravity, OpenCode y pi (fase 3).
- [x] **3 · Freno de bucles** (2026-11-26): tras `LOOP_MAX_EXCHANGES` (10) idas y vueltas entre dos sesiones sin turno humano
      (se reinicia tras `LOOP_RESET_MINUTES`=30 sin mensajes), los siguientes quedan retenidos (`freno_de_bucle`) y ambas
      sesiones reciben un aviso del servidor. Se reanuda con un turno humano o con «Reanudar» en el panel (fase 2).
- [x] **4 · Nombre automático** (2026-11-26): el `headersHelper` manda repo + rama (si no es la principal) como sugerencia,
      `X-Session-Auto: 1`, etiquetas (repo, rama) y descripción; el servidor nombra el chat si el nombre está libre y, si
      choca, el formulario propone `nombre-2` y avisa. `INTERCOM_ASK_NAME=1` vuelve a preguntar siempre.
- [x] **5 · Reparto de trabajo** (2026-11-26): `add_task` con `tags` avisa a las sesiones con esas
      etiquetas (si la tarea está lista), al creador al completarse o devolverse, y a las dependientes al quedar listas;
      `list_tasks` filtra por `tag`, `mine` y `state`; `ask_user` admite `person` (otra persona). Patrón coordinador/trabajador en `SKILL.md`.
- [x] **6 · Visibilidad** (2026-11-26): panel en `/web/` (sesiones y presencia, conversaciones entre agentes, buzón de tus
      sesiones, tareas con progreso, canales, preguntas). Escritura mínima: contestar `ask_user`, política de entrada de tus
      sesiones y «Reanudar» conversaciones pausadas. Entrada con la llave o con un enlace de un solo uso (`dashboard_link`,
      `intercom web:link`). Cookie HttpOnly/SameSite=Strict, CSP estricta, todo el contenido como texto. `WEB_VISIBILITY`
      `own` (por defecto) o `all`. Avisos del navegador para preguntas y pausas. CLI: `intercom feed [--follow]`.
      Falta en el despliegue: exponer `/web/*` y `/join*` en Caddy (fase 4).
- [x] **7 · Alta en un paso** (2026-11-26): `intercom invite:create <agente>` → enlace `…/join#aii_…` (un solo uso, caduca en
      `INVITE_HOURS`=48) → `node scripts/install.mjs --client claude --join "<enlace>"` canjea la llave y la guarda solo
      para el usuario (ACL / 0600). El `headersHelper` manda `Authorization` leyendo el archivo en cada conexión: sin
      variable de entorno ni reinicio (Codex/OpenCode siguen necesitando la variable: en Windows el instalador la fija).
      Probado de punta a punta con un servidor local (canje, llave válida, segundo canje rechazado).
- [x] **2/3 en clientes** (2026-11-26): vigilante, plugin de OpenCode y extensión de pi ignoran lo retenido; los hooks de
      Claude Code, Codex y Antigravity llaman a `/v1/human-turn` en el turno del usuario y en `Stop` solo entregan lo que despierta.
- [~] **8 · Fiabilidad** (código hecho 2026-11-26, falta instalarlo en la VM):
      - Servidor: copias automáticas en `BACKUP_DIR` (cada `BACKUP_EVERY_HOURS`=24, se conservan `BACKUP_KEEP`=14);
        `/healthz` informa `db`, `lastBackupAt` y `backupStale`. CLI: `backup:now`, `backup:verify`, `backup:test`
        (ensayo de restauración en carpeta temporal, sin tocar producción) y `restore --force` (aparta la base actual).
        Probado en `test/backup.test.ts`.
      - VM: `deploy/bin/intercom-backup-offsite` (gzip + gpg AES-256 + `gcloud storage cp`) e `intercom-monitor` (salud,
        copias, `/mcp`→401, `/web/`→200, días de certificado, disco, unidades; aviso solo en transiciones por webhook/ntfy
        y syslog), con timers de systemd y `deploy/intercom-ops.example`.
      - Caddy expone `/web*` y `/join*`; fail2ban no cuenta los 404 de esas rutas ni los 401 de lecturas del panel sin sesión.
      - **Falta (operador):** instalar scripts y timers, crear la clave de cifrado (y guardarla fuera de la VM), el bucket con
        regla de ciclo de vida, `BACKUP_DIR`/`PUBLIC_URL` en el servidor, recargar Caddy y fail2ban, y hacer un ensayo con
        una copia real descargada del bucket (`intercom backup:test`).
