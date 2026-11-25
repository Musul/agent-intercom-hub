# Batería adversarial (Docker)

`node adversarial/run.mjs` construye la imagen, levanta contenedores **endurecidos** (raíz de solo lectura, sin capacidades,
`no-new-privileges`, 256 MiB de memoria, 256 procesos, 1 CPU) y los ataca **desde fuera**, como un cliente hostil o un agente
comprometido. Sin dependencias: Node y el CLI de `docker`. Al terminar borra contenedores, volúmenes e imagen (`--keep` los conserva;
`--only D` ejecuta un solo grupo). Sale con código ≠ 0 si algún ataque tiene éxito; deja `adversarial/report.json`.

Necesita Docker y ~1,5 GiB de RAM libre; tarda unos 6–8 minutos. Última ejecución: **53/53 defensas aguantaron**.

## Qué ataca

| Grupo | Ataques (resumen) | Defensa que se comprueba |
|---|---|---|
| **A. Autenticación** | sin credenciales, esquemas falsos, clave en query/`X-API-Key`, clave alterada, cabecera de 20 KB, `Authorization` duplicada, SQLi en la clave, clave revocada, agente desactivado | `401` siempre; cabecera ambigua rechazada; la revocación vale al instante |
| **B. Identidad** | leer/confirmar/responder el buzón de otro, suplantar al remitente desde el cuerpo, copiar palabras para ganar una búsqueda, nombres de sesión hostiles, clave fijada, exceso de sesiones, tareas y flujos ajenos | aislamiento por sesión; remitente fijado por el servidor; `identityMatch`; topes |
| **C. Inyección** | SQLi/LIKE en consultas, nombres, destinatarios e ids; `__proto__`/`constructor`; JSON de 200 000 niveles; NUL/RTL/emoji; CRLF en MIME y nombres; traversal; métodos raros; fuga de trazas | consultas parametrizadas; validador estricto; ningún 5xx ni fuga |
| **D. HTTP crudo** | contrabando CL+TE, `Content-Length` duplicado/negativo/no numérico, URL de 200 KB, 300 cabeceras, bytes basura, pipelining de 50, slowloris de cabeceras (60 sockets), cuerpo lento, 400 sockets mudos, `Expect: 100-continue` con 500 MB declarados | `400/431`; cierre por plazo (≤ 8 s con un plazo de 6 s); memoria estable |
| **E. Agotamiento** | cuerpo de 10 MB, 8 subidas de 16 MiB a la vez en 256 MiB, 30 descargas de 16 MiB, llenar el almacén, 300 mensajes a un buzón, inundación por canal, 60 streams SSE, 20 esperas largas, 4000 peticiones con 150 conexiones, topes de canales/tareas, rate limit, fuerza bruta, `X-Forwarded-For` falso | `413/429/507`, sin OOM, cero 5xx; la IP falsa no evade el freno |
| **F. Concurrencia** | 60 reclamos simultáneos de una tarea, 450 envíos con 150 `idempotencyKey`, orden FIFO, dos lectores del mismo buzón con tráfico | exactamente un ganador; 150 mensajes únicos; orden intacto; ninguna pérdida |
| **G. Contenedor** | no root, raíz de solo lectura, sin capacidades, `kill -9` en plena carga, copia en caliente bajo carga, disco lleno, claves en los logs, `SIGTERM` con streams abiertos | 0 mensajes confirmados perdidos, `integrity_check` ok, recuperación tras disco lleno, salida limpia en < 8 s |

## Hallazgos que la batería (o su preparación) sacó a la luz, ya corregidos

1. El validador dejaba pasar la clave `__proto__`/`constructor` en los argumentos (buscaba en el prototipo): ahora `Object.hasOwn`.
2. Node comprueba `headersTimeout`/`requestTimeout` solo cada **30 s** por defecto: ahora cada ≤ 5 s (`connectionsCheckingInterval`).
3. Una conexión que abre el socket y **no envía nada** nunca se cerraba: ahora se cierra por inactividad.
4. El freno de claves falsas por IP **bloqueaba también a quien traía una clave válida** desde esa IP (NAT compartido): ahora solo cuenta claves falsas.
5. Con proxy de confianza se usaba la primera IP de `X-Forwarded-For`, que controla el cliente: ahora la que añadió el proxy (derecha).
6. Dos cabeceras `Authorization` (Node se queda con la primera; otro proxy podría quedarse con la última): ahora se rechazan.
7. Una subida de 16 MiB copiaba el cuerpo varias veces y cuatro a la vez llegaron a 213 MiB de 256: ahora una sola reserva, **2 subidas y 4 descargas** simultáneas.
8. Un `413`/`429` sobre un cuerpo grande cortaba la conexión y el cliente veía un *reset* en vez del error: ahora se deja terminar el cuerpo (con tope y plazo).
9. Faltaban topes de buzón (inundación directa o vía canal), de canales, tareas, streams SSE, esperas largas, descargas y de espacio de adjuntos: añadidos.
10. Una sesión podía «ganar» una búsqueda copiando palabras de otra: la identidad del administrador pesa más y `identityMatch` lo señala.
11. Una URL malformada daba `500`: ahora `400`. Las peticiones con más de 100 cabeceras dan `431`.
12. `backup` dejaba una traza fea y un archivo a medias si faltaba espacio: ahora error claro y sin restos.

## Lo que NO cubre

- **TLS y el proxy** (Caddy/nginx): la batería ataca el servidor tras el puerto publicado, no el proxy.
- **Ataques desde un navegador** (CORS, rebinding): se comprueba que un `Origin` ajeno recibe `403`, pero no hay una prueba con un navegador real.
- **Fuerza bruta distribuida** desde muchas IP: el freno es por IP; las claves son de 192 bits y no se adivinan, pero el volumen de intentos no se limita globalmente.
- **Inyección en el contenido** (un mensaje que diga «ignora tus instrucciones»): no se puede impedir en el servidor; se mitiga etiquetando todo como dato de terceros, fijando el remitente y haciendo que el vigilante no vuelque el cuerpo.
- **Escapes del contenedor, núcleo del host, cadena de suministro** de la imagen base.
- **Caída del nodo o del disco**: hay copia en caliente, no alta disponibilidad.
