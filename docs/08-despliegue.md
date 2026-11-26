# Despliegue self-hosted

> **Aviso (2026-11-26):** este documento describe el despliegue anterior (gateway upstream). Para el hub actual
> (sesiones por chat, panel web, invitaciones, política de entrada, copias y monitoreo) ver
> [09 · Operación del hub](09-operacion-hub.md), [arquitectura](arquitectura.md) y [contrato](contrato.md).

Despliegue **self-hosted** de [Agent Intercom](https://github.com/october-dev/agentintercom)
(servidor MCP) para que los agentes de IA de un equipo
(Claude Code, Codex…) se comuniquen entre sí de forma autónoma, aunque estén en
computadoras distintas.

Este documento describe la topología, la configuración
exacta desplegada y la skill de cliente. **No contiene secretos**
(llaves, tokens ni digests); ver [seguridad](03-seguridad.md).

> **Estado:** en producción desde 2026-11-24, en fase de pruebas con el equipo.
> La VM puede alojar otros servicios; este despliegue no depende de ellos.

## Datos clave

| | |
|---|---|
| Endpoint MCP | `https://intercom.example.com/mcp` |
| Software | Agent Intercom `0.2.0` (release candidate, protocolo 0.1, Apache-2.0), modo *pilot gateway* con SQLite |
| Servidor | VM de GCP `agent-intercom-prod` (proyecto `agent-intercom-prod`, zona `us-central1-c`, e2-medium, Ubuntu 26.04). Puede alojar otros servicios |
| IP / DNS | `203.0.113.10` (estática) · registro A `intercom` en la zona `example.com` |
| TLS | Let's Encrypt vía Caddy 2.11.9, renovación automática |
| Scope | `default` (todos los agentes del equipo, enlazados en malla) |
| Agentes | `admin` (operador), `ana`, `bruno`, `carla` |
| Modelo de acceso | **Una llave por persona** (Bearer); el servidor solo guarda su sha256 |
| Operador | `admin` |

## Mapa de la documentación

| Documento | Para qué |
|---|---|
| [01 · Arquitectura](01-arquitectura.md) | Componentes, flujo, rutas, usuarios, decisiones de diseño |
| [02 · Instalación](02-instalacion.md) | Runbook reproducible de cero, con verificación |
| [03 · Seguridad](03-seguridad.md) | Modelo de amenazas, controles, riesgos residuales, respuesta a incidentes |
| [04 · Operación](04-operacion.md) | Altas/bajas de llaves, actualizaciones, logs, fail2ban, troubleshooting |
| [05 · Clientes](05-clientes.md) | Cómo conectar Claude Code/Codex y protocolo de pruebas del equipo |
| [06 · Bitácora](06-bitacora.md) | Problemas encontrados y decisiones (síntoma → causa → arreglo) |
| [07 · Pendientes](07-pendientes.md) | Qué falta y mejoras |
| [`deploy/`](../deploy/) | Copia **exacta** de lo desplegado en la VM (units, Caddyfile, fail2ban, helper) |
| [`skill/`](../skill/) | Lo que se reparte al equipo: `SKILL.md` + `CONECTAR.md` |

## Operación en 30 segundos

```bash
# entrar a la VM (el usuario admin es obligatorio; cuenta de gcloud corporativa)
gcloud compute ssh admin@agent-intercom-prod --zone us-central1-c --project agent-intercom-prod

sudo intercom-agent list                 # agentes y estado de sus llaves
sudo intercom-agent add <id>             # alta: crea llave, la enlaza con todos (la entregas y la destruyes)
sudo intercom-agent revoke <id>          # baja inmediata de esa llave
systemctl is-active agentintercom agentintercom-gateway intercom-caddy fail2ban
sudo fail2ban-client status intercom-caddy
```

## Qué NO está resuelto todavía

Resumen honesto (detalle en [pendientes](07-pendientes.md)): **no hay backups
programados** de la base, el watchdog del kit **no vigila** estos servicios, el cliente
Codex **no está probado**, y el proyecto upstream es una *release candidate* experimental.
