# 02 · Instalación (runbook reproducible)

> **Aviso (2026-11-26):** este documento describe el despliegue anterior (gateway upstream). Para el hub actual
> (sesiones por chat, panel web, invitaciones, política de entrada, copias y monitoreo) ver
> [09 · Operación del hub](09-operacion-hub.md), [arquitectura](arquitectura.md) y [contrato](contrato.md).

Reproduce el despliegue **desde cero** en una VM Ubuntu con systemd. Los archivos a
instalar están en [`../deploy/`](../deploy/). Cada paso termina con una comprobación.

Requisitos: acceso `sudo`, un nombre DNS bajo tu control, Node.js (solo para obtener el
binario nativo vía npm), `curl`, y `gcloud` autenticado si el firewall es de GCP.

Variables usadas abajo:

```bash
HOST=intercom.example.com
AI="sudo -u october-bus env OCTOBER_BUS_DATA_DIR=/var/lib/october-bus OCTOBER_BUS_RUNTIME_DIR=/run/october-bus /opt/agentintercom/current/agentintercom"
```

## 1. Obtener y verificar el binario de Agent Intercom

`latest` en npm apunta a un placeholder: **fija la versión**.

```bash
npm install -g agentintercom-cli@0.2.0                       # prefijo ~/.local, sin sudo
BIN=~/.local/lib/node_modules/agentintercom-cli/node_modules/@october-dev/agentintercom-linux-x64/bin/agentintercom
npm view @october-dev/agentintercom-linux-x64@0.2.0 dist.attestations   # procedencia SLSA (debe existir)
"$BIN" --version                                              # agentintercom 0.2.0 (protocol 0.1)
```

## 2. Instalarlo en una ruta de root (solo lectura para el servicio)

```bash
sudo install -d -m 0755 -o root -g root /opt/agentintercom/releases/0.2.0
sudo install -m 0755 -o root -g root "$BIN" /opt/agentintercom/releases/0.2.0/agentintercom
( cd /opt/agentintercom/releases/0.2.0 && sudo sha256sum agentintercom | sudo tee SHA256SUM )
sudo ln -sfn releases/0.2.0 /opt/agentintercom/current
sudo ln -sfn /opt/agentintercom/current/agentintercom /usr/local/bin/agentintercom
npm uninstall -g agentintercom-cli                            # evita una segunda copia suelta
```

SHA-256 del binario desplegado: `9c3f22f0ec704c9c3b9a77f32505cf12d7c73a6bff957e68f27f27c25ceaad1c`.

## 3. Usuario de sistema aislado

```bash
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin october-bus
```

## 4. Daemon

```bash
sudo install -m 0644 deploy/systemd/agentintercom.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentintercom.service
$AI doctor            # "Agent Intercom is ready" (espera unos segundos tras arrancar)
```

> Al hacer polling de `doctor` no uses `grep ready`: "not ready" también contiene "ready".

## 5. Scope, gateway y primera llave

```bash
$AI scope create default
sudo install -d -m 0700 -o october-bus -g october-bus /var/lib/october-bus/keys
$AI gateway init --public-url https://$HOST --scope default --agent admin --name admin \
    --config /var/lib/october-bus/gateway.json --key-file /var/lib/october-bus/keys/admin.key
sudo install -m 0644 deploy/systemd/agentintercom-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentintercom-gateway.service
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $HOST" http://127.0.0.1:8787/health/ready   # 204
```

Sin `--name`, `gateway init` pone el nombre visible "Muse connector" (así quedó al principio y se
corrigió a mano en `gateway.json`); el helper del paso 6 usa el id como nombre.

## 6. Helper de altas y bajas

```bash
sudo install -m 0750 -o root -g root deploy/bin/intercom-agent /usr/local/sbin/intercom-agent
sudo intercom-agent add bruno      # repetir por cada agente (enlaza con todos los demás)
sudo intercom-agent list
```

## 7. Caddy oficial verificado

En una estación de trabajo (no en la VM), descarga y verifica:

```bash
gh release download v2.11.9 --repo caddyserver/caddy \
   --pattern 'caddy_2.11.9_linux_amd64.tar.gz' --pattern 'caddy_2.11.9_checksums.txt' \
   --pattern 'caddy_2.11.9_checksums.txt.sig' --pattern 'caddy_2.11.9_checksums.txt.pem'
# 1) SHA-512 del tarball contra checksums.txt (la línea trae SHA-512, no SHA-256)
# 2) firma sigstore sobre checksums.txt: la .pem y la .sig vienen en base64
base64 -d caddy_2.11.9_checksums.txt.pem > cert.pem ; base64 -d caddy_2.11.9_checksums.txt.sig > sig.bin
openssl x509 -in cert.pem -noout -issuer -ext subjectAltName   # emisor sigstore; SAN = workflow release.yml de caddyserver/caddy @ el tag
openssl x509 -in cert.pem -pubkey -noout > pub.pem
openssl dgst -sha256 -verify pub.pem -signature sig.bin caddy_2.11.9_checksums.txt   # Verified OK
```

(La cadena del certificado hasta la raíz de Fulcio no se validó; sí la firma, el emisor y la
identidad del workflow. Para validación completa usa `cosign verify-blob`.) Copia el tarball
a la VM y, ahí:

```bash
echo "<sha512 oficial>  caddy_2.11.9_linux_amd64.tar.gz" | sha512sum -c -
mkdir -m 700 /tmp/cx && tar -xzf caddy_2.11.9_linux_amd64.tar.gz -C /tmp/cx caddy
sudo install -d -m 0755 /opt/caddy/2.11.9 && sudo install -m 0755 /tmp/cx/caddy /opt/caddy/2.11.9/caddy
sudo ln -sfn 2.11.9 /opt/caddy/current && rm -rf /tmp/cx
sudo useradd --system --no-create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
sudo install -d -m 0700 -o caddy -g caddy /var/lib/caddy
sudo install -d -m 0750 -o caddy -g caddy /var/log/caddy
sudo install -m 0640 -o caddy -g caddy /dev/null /var/log/caddy/intercom-access.log
sudo install -d -m 0755 /etc/caddy
sudo install -m 0640 -o root -g caddy deploy/caddy/Caddyfile /etc/caddy/Caddyfile   # ajusta el host si cambia
sudo -u caddy env XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy/config \
   /opt/caddy/current/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # "Valid configuration"
sudo install -m 0644 deploy/systemd/intercom-caddy.service /etc/systemd/system/ && sudo systemctl daemon-reload
```

**No lo habilites todavía**: sin DNS, Caddy intentaría emitir el certificado y se toparía
con límites de Let's Encrypt.

## 8. fail2ban (solo la jaula propia)

```bash
# evitar que el paquete arranque con las jaulas por defecto antes de configurar
printf '#!/bin/sh\nexit 101\n' | sudo tee /usr/sbin/policy-rc.d >/dev/null && sudo chmod +x /usr/sbin/policy-rc.d
sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban nftables
sudo rm -f /usr/sbin/policy-rc.d
sudo install -m 0644 deploy/fail2ban/filter.d/intercom-caddy.conf /etc/fail2ban/filter.d/
sudo install -m 0644 deploy/fail2ban/jail.d/00-intercom.local /etc/fail2ban/jail.d/
sudo fail2ban-client -t                      # "configuration test is successful"
sudo systemctl enable --now fail2ban && sudo fail2ban-client status intercom-caddy
```

El `.local` desactiva la jaula `sshd` a propósito (cambio fuera del alcance de este servicio).

## 9. DNS y firewall

1. En tu proveedor DNS: registro **A** `intercom` → IP de la VM. Comprueba con resolvers públicos
   (`nslookup intercom.example.com 8.8.8.8`); tu resolver local puede tardar por caché negativa.
2. Regla de firewall propia (en PowerShell, entrecomilla `--rules`: la coma parte el argumento):

```
gcloud compute firewall-rules create intercom-web --project <proyecto> --direction=INGRESS --action=ALLOW '--rules=tcp:80,tcp:443' --source-ranges=0.0.0.0/0 --target-tags=intercom-web
gcloud compute instances add-tags <instancia> --zone <zona> --project <proyecto> --tags=intercom-web
```

## 10. Publicar

```bash
sudo systemctl enable --now intercom-caddy.service
sudo journalctl -u intercom-caddy.service --no-pager | grep -E "certificate obtained successfully"
sudo ss -ltn | grep -E ':(80|443) '          # Caddy escucha; si no, otro servicio ocupa el puerto
```

## 11. Verificación (lista de aceptación)

Desde **fuera** de la VM (con `--resolve` si tu DNS local aún no resuelve):

| Prueba | Esperado |
|---|---|
| `curl -sI http://$HOST/mcp` | `308` hacia `https://` |
| `openssl s_client -connect IP:443 -servername $HOST` | TLS 1.3, emisor Let's Encrypt, CN = `$HOST` |
| `POST /mcp` sin llave | `401` |
| `POST /mcp` con llave falsa | `401` |
| `GET /`, `/health/ready`, `/bus/v1/me`, `/v1/admin`, `/.env` | `404` |
| `POST /mcp` con cuerpo > 1 MiB | `413` |
| `https://<IP>/` (sin SNI válido) | falla el handshake |
| Cabeceras | `Strict-Transport-Security`, `X-Content-Type-Options`, `Cache-Control: no-store`; sin `Server` |
| Llave real: `tools/list` | `200` y 23 herramientas |
| Dos agentes: `message_peer` request → `check_inbox` → response → `acknowledge_messages` | llega y el recibo pasa a `acknowledged` |
| Revocar una llave | esa da `401`, las demás siguen `200` |
| `systemd-analyze security` de las 3 unidades | ≤ 1.4 (OK) |

Notas de pruebas desde Windows: pasa la llave con `curl.exe -H "@archivo"` (archivo de cabeceras con
permisos restringidos) y el JSON con `--data-binary "@archivo"`; PowerShell 5.1 se come las comillas
del JSON en línea (da `400`) y una llave en la línea de comandos queda en el historial.

## 12. Entrega de llaves

Ver [operación](04-operacion.md#alta-de-un-agente-y-entrega-de-su-llave).
