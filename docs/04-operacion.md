# 04 · Operación

## Acceso a la VM

```bash
gcloud compute ssh admin@agent-intercom-prod --zone us-central1-c --project agent-intercom-prod
```

- El usuario **`admin@` es obligatorio**; sin él gcloud entra con el usuario local de Windows.
- La cuenta activa de `gcloud` debe ser la corporativa (`gcloud auth list`).
- Windows: ejecuta `gcloud` desde **PowerShell** (en Git Bash falla por la ruta de Python). Para scripts largos, `gcloud compute scp` al servidor
  (ruta **absoluta**: `pscp` no expande `~`) y `tr -d '\r' < script | bash`; no pases scripts por stdin.
- La VM puede alojar otros servicios: **no tocar** su `docker`, ni sus puertos, ni sus reglas de firewall.

## Atajo para los comandos administrativos

```bash
AI="sudo -u october-bus env OCTOBER_BUS_DATA_DIR=/var/lib/october-bus OCTOBER_BUS_RUNTIME_DIR=/run/october-bus /opt/agentintercom/current/agentintercom"
$AI doctor        # diagnóstico; el resto de subcomandos: `agentintercom --help`
```

## Estado

```bash
systemctl is-active agentintercom agentintercom-gateway intercom-caddy fail2ban   # 4 × active
sudo ss -ltn | grep -E ':(80|443|4765|8787) '   # 80/443 públicos (Caddy); 4765/8787 solo 127.0.0.1
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: intercom.example.com" http://127.0.0.1:8787/health/ready   # 204
sudo intercom-agent list
sudo fail2ban-client status intercom-caddy
sudo systemctl show intercom-caddy -p Wants -p Requires --no-pager
```

Logs:

```bash
sudo journalctl -u agentintercom-gateway.service -n 100 --no-pager
sudo journalctl -u agentintercom.service -n 100 --no-pager
sudo journalctl -u intercom-caddy.service -n 100 --no-pager
sudo tail -f /var/log/caddy/intercom-access.log        # JSON; Authorization redactada
```

> El journal del sistema vive en RAM (~15 h de retención); para más atrás, `/var/log/syslog*`.

## Alta de un agente y entrega de su llave

```bash
sudo intercom-agent add <id>      # id: minúsculas, dígitos y guiones (2–32); convención = parte local del email
```

Hace, en orden: mintea la llave (`gateway key`), añade `{scope, agent, name, apiKeySha256}` a
`gateway.json`, **reinicia el gateway** (segundos) y enlaza el agente con todos los existentes.
La llave queda en `/var/lib/october-bus/keys/<id>.key`.

Entrega segura (así se hizo con el equipo):

1. Traer la llave a la PC del operador **sin mostrarla** ni pasarla por línea de comandos: `ssh … "sudo cat …/keys/<id>.key"`
   capturado en una variable y escrito a un archivo en una carpeta con ACL solo del usuario.
2. Probarla desde internet (`tools/list` → `200`) y confirmar que el operador la ve en `list_peers`.
3. Destruir la copia del servidor: `sudo shred -u /var/lib/october-bus/keys/<id>.key`.
4. Enviar la llave por un canal privado, una por persona; que quien la reciba borre el mensaje al guardarla; el operador borra su copia.

Estado de las llaves: `sudo intercom-agent list` (*pendiente de entregar y destruir* / *entregada/destruida*).

## Baja o rotación

```bash
sudo intercom-agent revoke <id>        # quita el cliente, destruye la llave si siguiera en disco, reinicia el gateway
sudo intercom-agent add <id>           # (rotación) nueva llave para el mismo id
```

**Límite conocido:** el agente revocado sigue apareciendo como *peer* en `list_peers` de los demás (no hay "desenlazar").
Si molesta y **no hay otros agentes con trabajo pendiente**: parar el gateway, borrar y recrear el scope
(`$AI scope delete --id default --confirm default && $AI scope create default`), arrancar el gateway y volver a enlazar
(`intercom-agent` enlaza al hacer `add`; para agentes ya existentes usa `$AI link --scope default <a> <b>`). Esto **borra mensajes y tareas**.

## fail2ban

```bash
sudo fail2ban-client status intercom-caddy                       # fallos, baneos activos
sudo fail2ban-client get intercom-caddy banip --with-time        # IPs baneadas y hasta cuándo
sudo fail2ban-client set intercom-caddy unbanip <IP>             # desbloquear (p. ej. un miembro tras muchos 401)
sudo fail2ban-client set intercom-caddy banip <IP>               # bloquear a mano
sudo fail2ban-regex /var/log/caddy/intercom-access.log /etc/fail2ban/filter.d/intercom-caddy.conf | tail
```

Parámetros: 20 coincidencias en 60 s → 1 h, incremento ×4, máximo 7 días. Cuenta 400/401/403/404, no 405.

## Certificado TLS

Automático (Caddy renueva ~30 días antes). Emitido 2026-11-24, vence 2027-02-22. Comprobar:

```bash
echo | openssl s_client -connect 203.0.113.10:443 -servername intercom.example.com 2>/dev/null | openssl x509 -noout -dates -issuer
```

Si falla la renovación: revisar `journalctl -u intercom-caddy`, que el DNS siga apuntando a la IP y que 80/443 sigan libres y abiertos.

## Cambios de configuración

- **Caddy** (`admin off`): editar `/etc/caddy/Caddyfile`, validar y **reiniciar** (`caddy validate …` → `sudo systemctl restart intercom-caddy`). No hay `reload`.
- **Gateway** (`gateway.json`): se aplica reiniciando `agentintercom-gateway`. Caddy usa `Wants=` del gateway: sigue arriba cuando el gateway se para o reinicia (responde con error de proxy hasta que vuelva).
- **Cambiar el dominio**: editar `publicURL` en `gateway.json` (reiniciar el gateway) y el nombre del sitio en el Caddyfile (reiniciar Caddy); crear el A y esperar el certificado. El gateway rechaza (403) cualquier `Host` distinto de `publicURL`.

## Actualizar Agent Intercom

Upstream avisa de que las migraciones pueden impedir volver atrás: **haz copia antes**.

```bash
# 1. copia (ver "Copia de seguridad")
# 2. obtener y verificar la nueva versión como en docs/02 §1-2 (en otro directorio de release)
sudo systemctl stop agentintercom-gateway.service agentintercom.service
sudo ln -sfn releases/<nueva> /opt/agentintercom/current
sudo systemctl start agentintercom.service && sleep 3 && sudo systemctl start agentintercom-gateway.service
# 3. repetir la lista de aceptación de docs/02 §11
```

Actualizar Caddy: nuevo directorio `/opt/caddy/<ver>`, verificar como en docs/02 §7, `ln -sfn`, `systemctl restart intercom-caddy`.
Reinicia también las conexiones de los clientes si el daemon se reinició.

## Copia de seguridad

> **No hay copia programada ni se ha probado la restauración** (pendiente). El comando existe en el CLI:

```bash
sudo install -d -m 0700 -o october-bus -g october-bus /var/lib/october-bus/backups
$AI backup --output /var/lib/october-bus/backups/bus-$(date +%F).db
```

Respalda además `gateway.json` y `/var/lib/october-bus/scopes/` (nunca copiar el `.db` en vivo sin su WAL). Guardar fuera de la VM y cifrado.

## Troubleshooting

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Nadie conecta; `curl https://…` no responde | Caddy parado o 80/443 ocupados | `systemctl is-active intercom-caddy`; `sudo ss -ltnp \| grep -E ':(80\|443) '`; si otro proceso los ocupa, no tocarlo y avisar |
| `502` de Caddy | Gateway caído o reiniciando | `systemctl status agentintercom-gateway`; esperar ~10 s tras un reinicio |
| `401 Invalid connector API key` | Llave mal copiada, revocada o variable de entorno vacía | Revisar con el usuario; `intercom-agent list`; reemitir |
| `403` con llave válida | `Host` ≠ `publicURL` (p. ej. se accede por IP) | Usar el nombre DNS |
| Un usuario no puede entrar tras varios intentos | IP baneada por fail2ban | `unbanip` |
| `doctor` dice *not ready* tras arrancar | Condición de carrera al arrancar | Reintentar a los segundos |
| El agente no responde a un mensaje | Un agente inactivo no despierta solo; debe llamar `check_inbox` | Pedirle que revise su bandeja |
| `list_peers` muestra un agente que ya no existe | Agente revocado (ver límite conocido) | Ver "Baja o rotación" |
| Caddy no arranca tras un cambio | Caddyfile inválido | `caddy validate`; recuperar el anterior |
| Conexión a `gcloud` falla con `Required 'compute.instances.get' permission` | Cuenta activa de gcloud no corporativa | `gcloud auth list`; usar la cuenta corporativa |
