# 06 · Bitácora

> **Aviso (2026-11-26):** este documento describe el despliegue anterior (gateway upstream). Para el hub actual
> (sesiones por chat, panel web, invitaciones, política de entrada, copias y monitoreo) ver
> [09 · Operación del hub](09-operacion-hub.md), [arquitectura](arquitectura.md) y [contrato](contrato.md).

Formato: **síntoma** → causa raíz → arreglo → cómo se evita que vuelva. Entradas nuevas arriba.
Todo ocurrió el 2026-11-24 salvo indicación.

## Caddy se cayó solo y no volvió (unidad con `Requires=`)

**Síntoma:** tras reiniciar el scope para limpiar agentes, la prueba pública dio `Connection refused` y
`intercom-caddy` estaba `inactive`. Estuvo caído unos minutos (nadie lo usaba aún).

**Causa:** `intercom-caddy.service` tenía `Requires=agentintercom-gateway.service`. Un `systemctl stop` del
gateway propaga la parada a Caddy, y un `start` posterior del gateway **no** arranca de nuevo a Caddy.

**Arreglo:** `Wants=` en lugar de `Requires=` (Caddy sigue arriba aunque el gateway esté parado; un reinicio
del gateway ya no lo afecta). Comprobado: con el gateway parado, Caddy sigue `active`.

**Prevención:** `deploy/systemd/intercom-caddy.service` ya lleva `Wants=`; el runbook y la guía de operación
usan `restart` del gateway, no `stop`+`start`. Tras tocar servicios, comprobar los 4 con `systemctl is-active`.

## Agente "fantasma" tras revocar

**Síntoma:** `list_peers` mostraba `prueba-tmp` y `prueba-pub` aunque sus llaves estaban revocadas.

**Causa:** revocar quita el cliente del gateway pero el agente y sus enlaces siguen en la base; no hay "desenlazar".

**Arreglo:** con el scope sin trabajo real, parar el gateway, `scope delete` + `scope create default`, arrancar.
Se hizo dos veces durante las pruebas (antes de crear a los agentes reales). **Borra mensajes y tareas.**

**Prevención:** documentado como límite conocido (docs/04). Hacer las pruebas con agentes temporales *antes* de
que haya trabajo real, o aceptar el fantasma.

## Los 200 de IPs desconocidas eran Let's Encrypt, no intrusos

**Síntoma:** el log de acceso mostraba respuestas `200` a decenas de IPs externas (AWS, etc.).

**Causa:** validación HTTP-01 *multi-perspectiva* de Let's Encrypt: pide `/.well-known/acme-challenge/<token>`
desde varias regiones. Se confirmó agrupando los 200 por método y ruta: 7 de desafío ACME (IPs externas) y 9 `POST /mcp`, todos desde la propia VM (mis pruebas).

**Arreglo:** ninguno necesario. **Prevención:** auditar con el agrupado por ruta antes de dar nada por intrusión.

## `doctor` decía "not ready" aunque el daemon estaba bien

**Síntoma:** tras arrancar el daemon, `doctor` falló y se creyó que la unidad endurecida lo rompía.

**Causa:** el bucle de espera usaba `grep -q ready` y "Agent Intercom is **not ready**" también contiene "ready":
salió del bucle de inmediato. Era solo una condición de carrera de arranque.

**Arreglo:** esperar unos segundos y repetir (y no hacer `grep ready`). El daemon estaba sano (sandbox incluido).

## `curl.exe` devolvía 400 al probar la llave desde PowerShell

**Síntoma:** `tools/list` con la llave del operador dio `HTTP 400` en vez de `200`.

**Causa:** PowerShell 5.1 elimina las comillas dobles al pasar `-d '{"jsonrpc":…}'` a un ejecutable nativo: el JSON llegó roto.
(El `400` y no `401` indicaba que la llave sí había pasado.)

**Arreglo:** el cuerpo va en un archivo (`--data-binary "@archivo"`) y la llave en un archivo de cabeceras (`-H "@archivo"`),
que además evita dejar la llave en la línea de comandos.

## La regla de firewall no se creó (coma en PowerShell)

**Síntoma:** `gcloud compute firewall-rules create … --rules=tcp:80,tcp:443` → `received [tcp:80 tcp:443]`.

**Causa:** PowerShell interpreta la coma como operador de lista y pasa dos argumentos.

**Arreglo:** entrecomillar: `'--rules=tcp:80,tcp:443'`. La etiqueta de red ya se había añadido (inocua sin regla).

## Una política del entorno rechazó una llamada a gcloud con `--account`

**Síntoma:** la ejecución de un script remoto fue denegada: contenía la cuenta de correo corporativa junto con el nombre del VM.

**Causa:** política de privacidad del entorno de Claude Code (no pasar el correo de la cuenta en comandos).

**Arreglo:** no se rodeó. Se comprobó que la cuenta activa de `gcloud` ya es la corporativa y se **omitió** `--account`.

**Prevención:** `gcloud auth list` antes de operar; con una cuenta distinta activa, el comando fallaría con `Required 'compute.instances.get' permission`.

## El dominio elegido no era controlable

**Síntoma/contexto:** se propuso `intercom.example.net`; el DNS de `example.net` lo gestiona otro proveedor y el operador no tiene acceso
(apex y `www` además apuntan a otro hosting, `198.51.100.25`). Ningún dominio propio apuntaba a la VM.

**Decisión:** `intercom.example.com`, con la zona DNS bajo control del operador. Cambio aplicado en `gateway.json` (`publicURL`) y Caddyfile
antes de publicar; verificado que no quedaran restos del dominio anterior. Sin registros CAA que bloquearan Let's Encrypt.

## El Caddy de Ubuntu es de 2022

**Contexto:** `apt-cache policy caddy` → candidato `2.6.2` en Ubuntu 26.04.

**Decisión:** Caddy oficial 2.11.9. El release no publica atestación de GitHub (`gh attestation verify` → 404); se verificó SHA-512 contra
`checksums.txt` y la firma sigstore con `openssl` (emisor sigstore, identidad = workflow de release de `caddyserver/caddy` en el tag).
La cadena hasta la raíz de Fulcio no se validó (no había `cosign`).

## `gcloud` no funciona desde Git Bash; `pscp` no expande `~`

**Síntoma:** `gcloud` desde Git Bash: `can't open file '…\gcloud.py'`. `gcloud compute scp … :~/f` → `unable to open ~/f`.

**Arreglo:** usar PowerShell para `gcloud`; rutas remotas absolutas (`/home/admin/…`); scripts por `scp` + `tr -d '\r' | bash`, nunca por stdin.

## Decisión de arquitectura: gateway *pilot*, no el servicio *standalone*

La documentación upstream describe dos despliegues. El *standalone* (Postgres 17, Supabase Auth, cifrado, restic) es multi-tenant y pesado;
el *pilot* (daemon + gateway + SQLite + proxy TLS) está marcado "experimental, operator-provisioned". Para 4 personas se eligió el *pilot*
asumiendo el riesgo (ver seguridad) y se mitigó con aislamiento del host y superficie mínima.

## Decisión: fail2ban no cuenta los 405

Los clientes MCP de HTTP sondean `GET /mcp` (SSE) y reciben `405`. Contarlos habría baneado a usuarios legítimos tras reconexiones.
Sí cuentan 400/401/403/404. Con la variable de llave ausente, Claude Code falla sin sondeo OAuth (probado), así que un error de configuración no dispara el baneo.
