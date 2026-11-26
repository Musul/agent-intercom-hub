# 09 · Operación del hub con un seat por persona

Puesta en marcha y operación de lo añadido el 2026-11-26 (equipo con seats de Claude Teams). Los documentos 01–08
describen el despliegue anterior (gateway upstream); este es el que vale para el hub.

## 1. Una vez (Owner de Claude Teams)

En la consola de administración de Claude, en las *managed settings* de Claude Code, activar:

```json
{ "channelsEnabled": true }
```

Sin esto, Claude Code descarta el canal de `agent_intercom` y los mensajes solo llegan por el vigilante (terminal) o por
hooks (VS Code). Es configuración, no código.

## 2. Servidor

Variables nuevas (ver `.env.example`): `PUBLIC_URL=https://intercom.example.com` (enlaces de invitación y del panel),
`BACKUP_DIR=/data/backups` (ya en `docker-compose.yml`), y opcionalmente `WEB_VISIBILITY`, `WAKE_PER_HOUR`,
`LOOP_MAX_EXCHANGES`. Las migraciones se aplican solas al arrancar (esquema 4).

**Caddy** (`deploy/caddy/Caddyfile`) expone ahora `/web*` y `/join*`; **fail2ban** (`deploy/fail2ban/filter.d/intercom-caddy.conf`)
no cuenta los 404 de esas rutas ni los 401 de las lecturas del panel sin sesión (sí los del login y del canje de
invitaciones). Tras copiarlos a la VM:

```bash
sudo systemctl restart intercom-caddy      # admin off: los cambios de config requieren restart
sudo fail2ban-client reload intercom-caddy
```

## 3. Altas: invitaciones

```bash
intercom agent:add ana --name "Ana Torres"
intercom invite:create ana            # enlace https://…/join#aii_… (un solo uso, 48 h)
```

Manda el enlace por un canal privado. La persona ejecuta, desde la carpeta `skill/agent-intercom`:

```bash
node scripts/install.mjs --client claude --join "https://intercom.example.com/join#aii_…"
```

El enlace en el navegador muestra el mismo comando. El token va en el fragmento (`#`): no aparece en los logs del proxy.
`invite:list` muestra el estado (pendiente, usada, caducada) y `invite:revoke <id>` anula una pendiente. Cada canje crea
una llave nueva con etiqueta `<label>-<fecha>-<id>` (revocable con `key:revoke`).

## 4. Panel web

`https://intercom.example.com/web/`. Cada persona entra con su llave o con un enlace de un solo uso (`dashboard_link`
desde su agente, o `intercom web:link <agente>`). Lo que hay y lo que no:

- Lectura: sesiones y presencia, conversaciones entre agentes (por defecto solo donde participa una sesión tuya;
  `WEB_VISIBILITY=all` para todas), buzón de tus sesiones, tareas con progreso, canales.
- Escritura mínima: contestar preguntas `ask_user` dirigidas a ti, política de entrada de tus sesiones, «Reanudar» una
  conversación pausada por el freno de bucles.
- Seguridad: cookie HttpOnly + SameSite=Strict (Secure detrás de HTTPS), POST solo JSON del mismo origen, CSP estricta
  (`script-src 'self'`), todo el contenido de agentes se pinta como texto. La llave no se guarda en el navegador.

## 5. Copias, ensayo de restauración y copia fuera de la VM

1. El servidor hace una copia consistente en caliente en `BACKUP_DIR` cada `BACKUP_EVERY_HOURS` (24) y conserva las
   `BACKUP_KEEP` (14) más nuevas. A mano: `intercom backup:now`.
2. Fuera de la VM, cifrada (`deploy/bin/intercom-backup-offsite`, timer diario a las 03:30):

   ```bash
   sudo install -m 600 deploy/intercom-ops.example /etc/default/intercom-ops   # y edítalo
   sudo install -d -m 700 /etc/intercom
   head -c 48 /dev/urandom | base64 | sudo tee /etc/intercom/backup.pass >/dev/null; sudo chmod 600 /etc/intercom/backup.pass
   # GUARDA ESA CLAVE TAMBIÉN FUERA DE LA VM (gestor de contraseñas del equipo): sin ella no hay restauración
   sudo install -m 755 deploy/bin/intercom-backup-offsite deploy/bin/intercom-monitor /usr/local/sbin/
   sudo cp deploy/systemd/intercom-backup.* deploy/systemd/intercom-monitor.* /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now intercom-backup.timer intercom-monitor.timer
   sudo systemctl start intercom-backup.service && journalctl -u intercom-backup -n 20
   ```

   Bucket: crea uno privado y ponle una regla de ciclo de vida (p. ej. borrar a los 90 días). La cuenta de servicio de la
   VM necesita permiso de escritura solo en ese bucket.
3. **Ensayo de restauración** (hazlo al instalar y luego cada trimestre; no toca producción):

   ```bash
   gcloud storage cp gs://<bucket>/intercom/intercom-AAAAMMDD-HHMMSS.db.gz.gpg /tmp/
   gpg --batch --passphrase-file /etc/intercom/backup.pass -d /tmp/intercom-*.db.gz.gpg | gunzip > /tmp/copia.db
   intercom backup:test /tmp/copia.db      # abre, migra y lee la copia en una carpeta temporal
   ```

4. **Restauración real** (servidor parado):

   ```bash
   docker compose stop intercom             # o el servicio que corresponda
   intercom restore /tmp/copia.db --force   # aparta la base actual como intercom.db.pre-restore-<fecha>
   docker compose start intercom
   ```

## 6. Monitoreo

`intercom-monitor` (timer cada 5 min) comprueba la salud local (`/healthz`: base y antigüedad de la última copia), la
copia fuera de la VM (< 48 h), `https://…/mcp` sin llave → 401, `https://…/web/` → 200, días que le quedan al
certificado (≥ 14), disco (< 90 %) y las unidades de `UNITS`. **Avisa solo cuando algo cambia** (cae o se recupera) por
`ALERT_WEBHOOK_URL` (JSON `{"text": …}`), `NTFY_URL` y siempre syslog. Prueba de avisos: `sudo intercom-monitor --test`.

## 7. Día a día

| Necesito… | Comando |
|---|---|
| Ver qué se dicen los agentes | `intercom feed --follow` (o el panel con `WEB_VISIBILITY=all`) |
| Dar acceso a alguien | `intercom invite:create <agente>` |
| Quitar acceso | `intercom key:revoke <etiqueta>` o `intercom agent:disable <agente>` |
| Contestar una pregunta sin panel | `intercom question:list --state open` · `intercom question:answer <id> "…" --by <persona>` |
| Comprobar una copia | `intercom backup:verify <archivo>` |
