# 07 · Pendientes y mejoras

Ordenado por prioridad. Marcar y fechar al cerrar cada uno.

## Alta

- [ ] **Backups programados y restauración probada.** Hoy no hay copia de `bus.db`, `gateway.json` ni `scopes/`.
      Usar `agentintercom backup --output …` en un timer, copia **cifrada fuera de la VM**, y ensayar una restauración.
- [ ] **Monitoreo.** El watchdog del kit no vigila `agentintercom`, `agentintercom-gateway`, `intercom-caddy` ni el certificado.
      Añadir comprobación de las 4 unidades, de `https://…` (401 esperado sin llave) y de la fecha de vencimiento del certificado, con aviso solo en transiciones.
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
- [ ] Actualizar docs 01–08: describen el despliegue anterior (gateway upstream), no este hub.
