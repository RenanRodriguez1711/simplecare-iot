# Informe de Arquitectura — SimpleCare IoT

**Fecha:** 26 de julio de 2026
**Alcance revisado:** `server/server.js` (292 líneas), `server/dashboard.html` (367 líneas), toda la carpeta `docs/` y `CONTINUAR.md`, en el estado del repositorio local.
**Método:** lectura completa del código y de la documentación. El código se trató como fuente de verdad; donde la documentación contradice al código, se señala explícitamente.

**Advertencia de alcance.** Esta revisión se hizo sobre la copia del repositorio en el PC local. No se accedió al VPS `2.24.196.49`, ni a `/root/write_config.py`, ni a `traccar.xml`, ni a la base de datos real, ni a la configuración de UFW, PM2 o Meta. Todo lo que se afirma sobre el estado del servidor proviene de la documentación del repositorio y está marcado como **no verificado** cuando corresponde. `CONTINUAR.md:144` advierte que el código del VPS se copia manualmente al repositorio, así que existe la posibilidad real de que lo que corre en producción difiera de lo revisado aquí.

---

## 1. Resumen ejecutivo

Ordenado por severidad.

- **La anonimización no cumple lo que la documentación afirma.** `server.js:86` hashea `event.deviceId`, que es el identificador interno autoincremental de Traccar (un entero pequeño, ver `docs/API.md:17-22`), no el IMEI. Un SHA256 sin sal de un entero en un rango de miles se revierte por fuerza bruta en milisegundos. `docs/PRIVACIDAD.md:39-46` y `docs/DECISIONES.md:22-31` afirman que el hash es irreversible porque se hashea el IMEI. La afirmación legal completa frente a la Ley 21.719 descansa sobre esta premisa, y la premisa no se sostiene tal como está el código.

- **Una alarma perdida no deja rastro y nadie se entera.** El webhook es fire-and-forget: `server.js:104-119` no tiene `try/catch`, no persiste el `event.id` de Traccar, no reintenta y no verifica nada. Si Node.js está caído, reiniciándose, o la escritura a SQLite falla, el evento se pierde de forma definitiva y silenciosa. No existe endpoint de salud, ni monitoreo, ni alerta de "hace N horas que no llega nada". Para un producto de alarma personal, esto es el hallazgo más importante desde el punto de vista de negocio.

- **El plan de mover el envío de WhatsApp a `server.js` convierte a Node.js en punto único de falla de la función que salva vidas.** Hoy Traccar envía el WhatsApp por su cuenta y ese camino sobrevive a un Node.js caído. Después del cambio, un crash de Node, un reinicio de PM2 o un token de Meta expirado significan que la familia no recibe la alarma. El plan es correcto en objetivo pero, tal como está descrito en `CONTINUAR.md:35`, le faltan cola persistente, idempotencia, reintentos, timeout y confirmación de entrega.

- **El token del municipio viaja en la query string sobre HTTP sin cifrar.** `server.js:49` lo lee de `req.query.token` y `dashboard.html:219` lo pone en cada URL. Sin TLS, cualquiera en la ruta de red lo captura. Además queda en el historial del navegador, en los logs de acceso y en cualquier proxy intermedio. El token no expira ni se puede revocar sin editar la base de datos a mano.

- **El webhook está abierto a Internet sin autenticación.** `server.js:104` acepta cualquier POST y `docs/DEPLOY.md:133` abre el puerto 3000 a Internet completo. Cualquiera puede inyectar eventos falsos. Hoy eso ensucia el dashboard; después del cambio planificado, permitiría disparar mensajes de WhatsApp falsos a familias reales y quemar la cuota y la calidad de la plantilla de Meta.

- **No hay backups de `events.db` y el comando para borrarla está copiado y listo para pegar en `CONTINUAR.md:152-157`.** El histórico anonimizado es precisamente el activo que se le vende al municipio. Un `DELETE FROM events` accidental o una falla de disco lo elimina sin posibilidad de recuperación.

- **La tabla `events` no tiene ni un solo índice** (`server.js:11-21`), y todas las consultas filtran por `device_hash`, `created_at` y `alarm_type`. Con 9.000 filas no se nota; con 1.000 dispositivos en operación durante un año (estimado 3–4 millones de filas) cada carga del dashboard hará varios recorridos completos de tabla. Como `better-sqlite3` es síncrono, esos recorridos bloquean el mismo hilo que recibe los webhooks de alarma.

- **El cliente `demo` con token fijo se recrea en cada arranque y se apropia de los dispositivos huérfanos** (`server.js:36-44`). Un dispositivo nuevo que emita un evento antes de ser asignado a su municipio queda pegado al cliente `demo` en el siguiente reinicio, y como `device_hash` es clave primaria, la asignación posterior al municipio correcto será ignorada silenciosamente.

---

## 2. Mapa del sistema actual

### Flujo de datos

```
┌─────────────────┐
│  EV07B (SOS)    │  Adulto mayor presiona el botón
└────────┬────────┘
         │ TCP protocolo minifinder2 → VPS puerto 5187
         ▼
┌──────────────────────────────────────────────────────┐
│  VPS único 2.24.196.49  (Hostinger, Ubuntu, root)    │
│                                                       │
│  ┌────────────────────────┐                          │
│  │ Traccar (Docker)       │                          │
│  │ puertos 8082 / 5187    │                          │
│  │ BD interna: H2         │                          │
│  └──┬──────────────────┬──┘                          │
│     │                  │                              │
│     │ CAMINO A         │ CAMINO B                    │
│     │ notificador      │ event.forward.url            │
│     │ whatsapp nativo  │ POST http://172.17.0.1:3000  │
│     ▼                  ▼                              │
│  ┌────────┐   ┌─────────────────────────────┐        │
│  │ Meta   │   │ Node.js + Express (PM2)     │        │
│  │ Cloud  │   │ puerto 3000, 1 solo proceso │        │
│  │ API    │   │ - anonimiza (SHA256 + GPS)  │        │
│  └───┬────┘   │ - normaliza nombres alarma  │        │
│      │        │ - persiste                  │        │
│      │        │ - sirve dashboard + API     │        │
│      │        └──────────┬──────────────────┘        │
│      │                   ▼                            │
│      │        ┌─────────────────────────────┐        │
│      │        │ SQLite /opt/simplecare/     │        │
│      │        │ events.db                   │        │
│      │        │ events / clients /          │        │
│      │        │ device_clients              │        │
│      │        └─────────────────────────────┘        │
└──────┼───────────────────────────────────────────────┘
       │                              ▲
       ▼                              │ HTTP sin TLS, token en query string
┌──────────────┐            ┌─────────┴──────────┐
│ WhatsApp del │            │ Funcionario        │
│ admin de     │            │ municipal          │
│ Traccar (uno │            │ (dashboard.html)   │
│ solo, hoy)   │            └────────────────────┘
└──────────────┘
```

### Responsabilidades por componente

| Componente | Responsabilidad hoy | Observación arquitectónica |
|---|---|---|
| **EV07B** | Emite SOS, caída, batería baja, conexión/desconexión por TCP | No se verificó si el firmware almacena y reenvía eventos cuando el servidor no responde. Es un supuesto crítico sin confirmar. |
| **Traccar** | Terminación del protocolo GPS, registro de dispositivos, notificación WhatsApp, reenvío de eventos | Es el único componente que hoy garantiza la alerta a la familia. El plan lo despoja de esa función. |
| **Node.js / Express** | Webhook, anonimización, normalización de nombres de alarma, persistencia, API del dashboard, servir el HTML | Cinco responsabilidades muy distintas en un proceso único y en un solo hilo. La ruta de ingesta de alarmas comparte hilo con la ruta de consulta del dashboard. |
| **SQLite** | Almacén único de eventos anonimizados, clientes y asignación dispositivo→cliente | Sin índices, sin WAL declarado, sin backup. |
| **dashboard.html** | Visualización: KPIs, mapa de calor, gráficos, tabla de riesgo, exportación CSV | Depende de tres CDNs externos, uno de ellos sin versión fijada. |
| **Meta Cloud API** | Entrega del mensaje de alarma | Token temporal de ~24 h, falla en silencio (`docs/APRENDIZAJES.md:153-165`). |

### Los dos caminos son hoy independientes — y eso es una virtud accidental

La observación arquitectónica más importante del sistema actual es que **el camino A (alerta a la familia) y el camino B (analítica municipal) no comparten ningún componente aguas abajo de Traccar**. Si Node.js se cae, se pierde analítica pero la familia sigue recibiendo el WhatsApp. Esa separación no fue una decisión de diseño, fue una consecuencia de haber usado el notificador nativo de Traccar, pero es la propiedad más valiosa que tiene el sistema hoy. El cambio planificado la elimina. El punto 5 de este informe desarrolla las implicancias.

---

## 3. Hallazgos

### H01 — El hash del dispositivo es reversible por fuerza bruta

**Severidad: Crítico**

**Qué está mal.** `server.js:86`:
```js
device_hash: crypto.createHash('sha256').update(String(event.deviceId)).digest('hex').slice(0, 16),
```

`event.deviceId` es el identificador interno de Traccar, un entero autoincremental. `docs/API.md:17-22` lo confirma en el ejemplo del payload: `"deviceId": 45`. No es el IMEI. El hash no lleva sal ni pimienta, y no usa una función de derivación con costo.

**Por qué importa.** `docs/PRIVACIDAD.md:39-46` afirma: *"Es irreversible matemáticamente (no se puede obtener el IMEI original desde el hash)"*, y `docs/DECISIONES.md:22-31` repite la premisa. Toda la propuesta comercial al municipio y toda la postura frente a la Ley 21.719 descansan en que los datos son anónimos y por tanto quedan fuera del alcance de la ley. Con un espacio de entrada de unos pocos miles de enteros, cualquiera con acceso a la base de datos o al CSV exportado recupera el `deviceId` original completo en menos de un segundo. Con el `deviceId` y acceso al panel de Traccar (`docs/ONBOARDING_MUNICIPIO.md:75` indica que ahí se guarda el nombre real de la persona), la reidentificación es directa.

Se agrava con `docs/DEPLOY.md:56`, que instruye a crear Traccar con usuario `admin`/`admin`, y `docs/SEGURIDAD.md:46-48`, que reconoce que el panel 8082 está expuesto a Internet sin HTTPS y que la contraseña por defecto podría no haberse cambiado (no verificable desde el repositorio).

**Escenario de falla.** Un funcionario municipal exporta el CSV desde el dashboard. Contiene fechas, tipos de alerta y zonas. Combinado con `/riesgo` y `/dispositivo/:id`, obtiene el listado de las personas de mayor riesgo con sus IDs anónimos. Un tercero que consiga la base de datos, o el propio municipio con un poco de curiosidad técnica, hashea los enteros del 1 al 100.000, arma la tabla inversa completa y consulta Traccar para poner nombre a cada ID. El municipio ya conoce la lista de beneficiarios del programa, así que la correlación no requiere ni acceso a Traccar.

**Recomendación.**
1. Introducir una sal secreta larga, almacenada fuera de la base de datos y fuera del repositorio: `sha256(sal_secreta + deviceId)`. Esto por sí solo cierra la fuerza bruta.
2. Preferible: no derivar el identificador anónimo del `deviceId` en absoluto. Generar un `pseudo_id` aleatorio en el momento del alta del dispositivo (panel admin, punto 2 del plan) y guardar la correspondencia IMEI↔`pseudo_id` en una base separada, con control de acceso propio, que nunca comparta proceso con el dashboard municipal.
3. Corregir `docs/PRIVACIDAD.md` y `docs/DECISIONES.md` para que describan lo que el sistema realmente hace. Una afirmación de anonimización que no se sostiene es peor que no hacer ninguna afirmación, porque induce a error al municipio y al adulto mayor que firma el consentimiento.

---

### H02 — Pérdida silenciosa de alarmas: el webhook no tiene manejo de errores, ni idempotencia, ni reintento

**Severidad: Crítico**

**Qué está mal.** `server.js:104-119`. El handler completo:
- No tiene `try/catch`. Si `db.prepare().run()` lanza (disco lleno, base bloqueada, corrupción), Express responde 500 y el evento se pierde.
- No persiste el `event.id` que Traccar sí envía en el payload (`docs/API.md:16`). Sin él no hay forma de deduplicar ni de auditar qué se perdió.
- Responde `200 OK` antes de cualquier verificación en la línea 106 para eventos no reconocidos, y en la línea 118 para el resto. Traccar recibe 200 y considera el evento entregado.
- No existe registro de eventos descartados: los tipos fuera de la lista blanca de `server.js:109` se descartan sin dejar traza.

Tampoco existe endpoint de salud en todo `server.js` que permita a un monitor externo distinguir "el sistema está bien y no hubo alarmas" de "el sistema está muerto".

**Por qué importa.** El producto es un botón de emergencia para adultos mayores. La diferencia entre "no hubo alarmas hoy" y "no procesamos ninguna alarma hoy" es la diferencia entre un servicio funcionando y una persona sin auxilio. Hoy el impacto está acotado porque el WhatsApp lo envía Traccar por el camino A, pero el registro para el municipio ya se pierde, y después del cambio planificado (H03) la pérdida será de la alerta misma.

**Escenario de falla.** El disco del VPS se llena — probable, considerando que `docs/SEGURIDAD.md:100` reconoce que la rotación de logs de PM2 está pendiente y que `server.js:108` y `server.js:116` escriben una línea de log por cada evento recibido. SQLite deja de poder escribir. Traccar sigue enviando webhooks, Node responde 500, Traccar no reintenta. Durante días, ninguna alarma queda registrada. Nadie lo nota porque el dashboard sigue mostrando los datos históricos y no hay alerta de disco ni de "cero eventos recibidos".

**Recomendación.**
1. Envolver el handler completo en `try/catch`, y ante cualquier excepción escribir el payload crudo en un archivo de respaldo en disco antes de responder. Nunca perder un evento por una excepción.
2. Agregar `traccar_event_id INTEGER UNIQUE` a la tabla `events` y hacer `INSERT OR IGNORE`. Esto habilita reintentos seguros y hace el procesamiento idempotente, requisito indispensable antes de H03.
3. Agregar `GET /health` que verifique la base y devuelva el timestamp del último evento recibido.
4. Monitor externo (UptimeRobot, Healthchecks.io, o un cron en otra máquina) que alerte si `/health` falla o si el último evento es más antiguo que un umbral. Con 1.000 dispositivos emitiendo conexión/desconexión, un silencio de más de una hora significa que algo está roto.

---

### H03 — El plan de mover WhatsApp a `server.js` elimina la única redundancia real del sistema

**Severidad: Crítico** (riesgo prospectivo — sobre la arquitectura planificada, no sobre la actual)

**Qué está mal.** `CONTINUAR.md:35` y `docs/DECISIONES.md:152-155` describen el plan: `server.js` llamará directamente a la API de Meta desde el webhook, usando una tabla de contactos, reemplazando el notificador nativo de Traccar.

El objetivo es correcto y necesario: Traccar no modela "contacto familiar por dispositivo", y hoy el WhatsApp llega al `phone` del usuario administrador. A 1.000 usuarios eso es inviable. Pero el plan tal como está descrito traslada la responsabilidad de la alerta a un componente que, según H02, no tiene manejo de errores, no es idempotente, no reintenta, corre en un solo proceso y no está monitoreado.

**Por qué importa.** Hoy hay dos caminos independientes desde Traccar. Después del cambio hay uno solo, y pasa por el eslabón más frágil de la cadena.

**Escenario de falla.** Son tres, todos concretos:

1. *Reinicio.* Un `pm2 restart simplecare` durante un despliegue. La ventana de arranque no es instantánea: `server.js:74-80` ejecuta una migración de normalización al inicio que recorre la tabla completa (H07). Un SOS que llegue en esa ventana se pierde por completo, no solo en la analítica sino en la alerta.

2. *Token expirado.* `docs/APRENDIZAJES.md:153-165` documenta que el token temporal de Meta expira cada ~24 h y que **el fallo es completamente silencioso**. Hoy eso ya rompe las alarmas y nadie se entera. Si `server.js` toma el control del envío sin agregar detección de error de la respuesta de Meta, se hereda exactamente el mismo fallo silencioso, con el agravante de que ahora es responsabilidad propia y no de un componente de terceros.

3. *Llamada colgada.* Si la llamada HTTP a Meta se hace dentro del handler del webhook sin timeout y Meta responde lento, el request de Traccar queda abierto. Traccar tiene su propio timeout de reenvío; al vencer, el evento queda en un estado indeterminado sin que nadie sepa si el mensaje salió.

**Recomendación.** Un diseño mínimo viable para el cambio:

- **Desacoplar.** El webhook hace tres cosas y nada más: valida el origen, escribe el evento en una tabla `outbox` con estado `pendiente`, responde `200` inmediatamente. El envío a Meta lo hace un trabajador aparte que lee la `outbox`. Nunca llamar a Meta dentro del handler HTTP.
- **Idempotencia.** `traccar_event_id UNIQUE` (ver H02) como clave de deduplicación.
- **Reintentos con retroceso exponencial** y un máximo de intentos, con dead-letter explícita: si tras N intentos el mensaje no salió, eso tiene que generar una alerta operativa a SimpleCare, no quedar en un campo de la base que nadie mira.
- **Verificar la respuesta de Meta.** Registrar el `message_id` devuelto. Distinguir errores recuperables (429, 5xx) de definitivos (190 token expirado, número inválido, plantilla pausada). Un código 190 debe disparar una alerta inmediata a SimpleCare, no un reintento silencioso.
- **Suscribirse a los webhooks de estado de Meta** (`sent`/`delivered`/`read`/`failed`) para saber si el mensaje efectivamente llegó al teléfono de la familia. Sin esto solo se sabe que se envió, no que se entregó. Para un sistema de alarmas la diferencia es sustantiva. Ese webhook entrante debe validar la firma `X-Hub-Signature-256`.
- **Token de larga vida.** Migrar al token de usuario de sistema (60 días) o a un mecanismo de renovación automática, con alerta anticipada de vencimiento. Nunca depender de un token de 24 h para una función de emergencia.
- **No apagar el camino de Traccar de inmediato.** Correr ambos en paralelo durante un período de transición, con deduplicación por el lado del contacto, y solo desactivar el notificador nativo cuando la ruta nueva tenga historial demostrado de entregas.
- **Escalamiento.** WhatsApp no garantiza atención. Un teléfono en silencio, sin batería o sin datos no recibe nada. Para un SOS real conviene definir un escalamiento a segundo contacto y, eventualmente, a SMS o llamada si no hay lectura en X minutos. Esto es una decisión de producto, pero la arquitectura de cola descrita arriba es la que la hace posible más adelante.

---

### H04 — Los datos personales de los contactos van a entrar en el sistema y no hay lugar diseñado para ellos

**Severidad: Crítico** (riesgo prospectivo)

**Qué está mal.** El plan requiere una tabla de contactos con nombre y teléfono de familiares de adultos mayores. `docs/PRIVACIDAD.md:63-71` declara explícitamente que el sistema **nunca** almacena número de teléfono ni datos de los contactos de emergencia. El punto 2 del plan (panel admin para asignar IMEI→municipio y contactos) y el punto 1 (notificación por contacto individual) rompen esa declaración de manera directa.

Si esa tabla se crea dentro de `/opt/simplecare/events.db`, el mismo archivo y el mismo proceso que sirve el dashboard municipal pasan a contener datos personales identificables de familias chilenas. El proceso que hoy no tiene HTTPS, cuya autenticación es un token en la query string, y cuyo webhook está abierto a Internet.

**Por qué importa.** Es el momento exacto en que el sistema pasa de "tratamiento de datos anonimizados" a "tratamiento de datos personales" bajo la Ley 21.719, con todas las obligaciones que eso implica: base de licitud, derechos ARCO, registro de actividades de tratamiento, notificación de brechas. Y ocurre como efecto secundario de una decisión técnica, no como una decisión consciente.

**Escenario de falla.** El token de un municipio se filtra (viaja en claro por HTTP, ver H05). El atacante recorre los endpoints. Si en algún momento se agrega un endpoint de contactos al mismo servidor sin un modelo de autorización distinto —lo natural cuando el panel admin se construye sobre el mismo `server.js`— obtiene el listado de teléfonos de las familias de los adultos mayores del programa. Es un conjunto de datos de alto valor para fraude telefónico dirigido a personas mayores.

**Recomendación.**
1. Base de datos **separada** para datos personales (`contacts.db` o, mejor, un motor con control de acceso propio), nunca en `events.db`.
2. El panel admin debe ser un servicio o al menos un router con autenticación y autorización propias, distintas del token de municipio. Idealmente no expuesto a Internet, sino accesible solo por VPN o restringido por IP.
3. Ningún endpoint accesible con un token de municipio debe poder alcanzar la base de contactos. Verificar esto explícitamente con una prueba, igual como se verificó el aislamiento entre tenants (`docs/CHANGELOG.md:14`).
4. Actualizar `docs/PRIVACIDAD.md` **antes** de escribir el código, no después, y revisar si el consentimiento informado pendiente (`docs/PRIVACIDAD.md:100`) cubre el tratamiento de los datos del contacto familiar, que es un tercero distinto del titular del servicio.

---

### H05 — Todo el tráfico va sin cifrar y el token de acceso viaja en la query string

**Severidad: Alto**

**Qué está mal.** `server.js:49` lee el token desde `req.query.token`. `dashboard.html:219, 316, 341` lo agrega a cada URL. No hay TLS en ninguna parte (`docs/SEGURIDAD.md:36-39`). El token no tiene fecha de expiración en el esquema (`server.js:23-27`), no se puede revocar sin editar SQL a mano, y `docs/DECISIONES.md:132-142` lo asume compartible entre funcionarios, lo que significa que circulará por correo y por WhatsApp del municipio.

**Por qué importa.** Un token en query string queda registrado en el historial del navegador, en los logs de acceso de cualquier proxy o del futuro Nginx, en marcadores compartidos, y en la barra de direcciones visible en una pantalla proyectada en una reunión municipal. Sobre HTTP sin cifrar, además, es interceptable en la red del municipio.

**Escenario de falla.** Un funcionario abre el dashboard desde el WiFi de una oficina municipal. Alguien en la misma red captura el token. Con ese token accede a `/riesgo` y `/export` y obtiene el listado completo de las personas de mayor riesgo del programa, con zonas y fechas. Combinado con H01, con nombres.

**Recomendación.** El punto 3 del plan (Nginx + Certbot en `panel.simplecare.cl`) es correcto y debe adelantarse antes de cualquier cliente real. Adicionalmente: mover el token de la query string a un header `Authorization` o a una cookie `HttpOnly` `Secure` `SameSite=Strict` establecida por un canje de un solo uso; agregar `expires_at` y `revoked_at` a la tabla `clients`; y configurar Nginx para no registrar query strings. Como mejora menor, comparar el token con `crypto.timingSafeEqual` en vez de dejar la comparación al `WHERE token = ?` de SQLite — con 24 bytes aleatorios el riesgo práctico de un ataque de temporización es despreciable, pero el cambio es trivial.

---

### H06 — El webhook acepta eventos de cualquier origen

**Severidad: Alto**

**Qué está mal.** `server.js:104` no valida origen, ni firma, ni secreto compartido. `docs/DEPLOY.md:133` abre el puerto 3000 a Internet completo (`ufw allow 3000/tcp`), no solo a la subred de Docker. `docs/SEGURIDAD.md:41-44` reconoce la brecha.

**Por qué importa.** Hoy permite envenenar el dashboard con datos falsos, lo que degrada el producto que se le vende al municipio. Después del cambio planificado (H03), permitiría disparar mensajes de WhatsApp a familias reales desde fuera, y quemar la cuota diaria y la calificación de calidad de la plantilla de Meta (ver sección 4).

**Escenario de falla.** Un escaneo automatizado de puertos encuentra el 3000 abierto. Un script envía miles de POST a `/webhook` con `alarm: "sos"` y coordenadas aleatorias. El dashboard del municipio muestra una epidemia de SOS inexistente y el panel de riesgo señala personas que no existen. La credibilidad del producto queda comprometida en la única métrica que el municipio compró.

**Recomendación.** Restringir el puerto 3000 en UFW a `172.17.0.0/16` únicamente y exponer el dashboard solo a través de Nginx en 443. Sumar un secreto compartido en un header entre Traccar y Node. Validar el esquema del payload antes de insertar. Aplicar `express-rate-limit` a `/webhook` con un umbral generoso pero finito.

---

### H07 — La tabla `events` no tiene índices y la migración de arranque recorre la tabla completa

**Severidad: Alto**

**Qué está mal.** `server.js:11-21` crea la tabla `events` sin ningún `CREATE INDEX`. Las columnas usadas en filtros son `device_hash` (en cada uno de los ocho endpoints, vía subconsulta `IN`), `created_at` (en todos los filtros de fecha y en los `ORDER BY`) y `alarm_type`. Ninguna está indexada.

Además, `server.js:74-80` ejecuta en cada arranque:
```js
for (const { alarm_type } of db.prepare('SELECT DISTINCT alarm_type FROM events ...').all()) { ... }
```
Un `SELECT DISTINCT` sin índice sobre `alarm_type` es un recorrido completo de tabla, y cada `UPDATE` posterior es otro recorrido completo. La operación es idempotente y correcta, pero su costo crece linealmente con el histórico y se paga en cada `pm2 restart`.

Tampoco se declara `journal_mode = WAL`. `better-sqlite3` no lo activa por defecto; en modo `delete`, un escritor bloquea a todos los lectores.

**Por qué importa.** Con los ~9.000 eventos actuales nada de esto se nota. La estimación a escala objetivo: 1.000 dispositivos generando conexión/desconexión más alarmas, del orden de 10 eventos por dispositivo por día, da unos 3,65 millones de filas al año, aproximadamente 300–400 MB. SQLite maneja ese volumen sin dificultad **con índices**. Sin ellos, cada carga del dashboard dispara cinco consultas concurrentes (`dashboard.html:337-343`), cada una con varios recorridos completos, y como `better-sqlite3` es síncrono, todo eso bloquea el hilo único de Node.

**Escenario de falla.** Tres funcionarios de distintos municipios abren el dashboard a la misma hora un lunes por la mañana. Cada carga dispara `/summary` (cinco consultas de conteo, `server.js:163-169`), `/heatmap`, `/events`, `/stats` y `/riesgo`. Sobre millones de filas sin índice, cada tanda toma segundos de CPU bloqueando el proceso. En esa ventana llega un webhook con un SOS. Queda encolado en el sistema operativo hasta que el hilo se libera; si el timeout de reenvío de Traccar vence antes, se pierde.

**Recomendación.**
```sql
CREATE INDEX IF NOT EXISTS idx_events_hash_created ON events(device_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_events_alarm_created ON events(alarm_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
```
Activar `db.pragma('journal_mode = WAL')` y `db.pragma('synchronous = NORMAL')` justo después de abrir la base. Convertir la migración de `server.js:74-80` en una migración versionada que corra una sola vez, no en cada arranque. Con estas tres medidas, SQLite deja de ser preocupación real a 1.000 dispositivos.

**Nota de honestidad técnica:** `docs/DECISIONES.md:18` fija el umbral de migración a PostgreSQL en 500 MB de archivo. El umbral es razonable, pero el cuello de botella a esta escala no es el motor de base de datos sino la falta de índices y el bloqueo del hilo único. Migrar a PostgreSQL sin resolver esas dos cosas no arreglaría nada.

---

### H08 — `/export` construye el CSV completo en memoria, sin límite de filas, en el hilo del webhook

**Severidad: Alto**

**Qué está mal.** `server.js:273-287`. La consulta no tiene `LIMIT`. El resultado completo se materializa en un array con `.all()`, luego se transforma en un segundo array de strings con `forEach`, y finalmente se concatena con `join('\n')` en un único string en memoria. Es el pico de memoria triplicado sobre el conjunto completo, y todo ocurre de forma síncrona.

**Por qué importa.** Es el único endpoint sin cota superior. Un municipio con 200 dispositivos y dos años de operación exporta cientos de miles de filas. Durante la construcción del CSV, el proceso Node está bloqueado y no procesa ningún webhook. Es la vía más directa para que una acción rutinaria de un funcionario impida el registro —y, tras H03, la entrega— de una alarma de emergencia.

**Escenario de falla.** Un funcionario municipal exporta "todo el histórico" sin poner fechas para armar un informe anual. El proceso queda bloqueado varios segundos. En ese lapso un adulto mayor presiona el botón SOS. El webhook queda esperando.

**Recomendación.** Transmitir la respuesta con `db.prepare(...).iterate()` escribiendo al `res` fila por fila, en vez de `.all()`. Imponer un rango de fechas máximo obligatorio (por ejemplo 12 meses) o un `LIMIT` alto con aviso de truncamiento. A mediano plazo, mover las consultas pesadas de lectura a un proceso separado que abra la base en modo solo lectura, dejando el proceso de ingesta dedicado exclusivamente al webhook.

---

### H09 — El cliente `demo` se apropia de los dispositivos no asignados en cada arranque

**Severidad: Alto**

**Qué está mal.** `server.js:36-44`:
```js
db.prepare(`INSERT OR IGNORE INTO clients (client_id, nombre, token) VALUES (?, ?, ?)`)
  .run('demo', 'Municipio Demo', 'demo-token-dev-only');

db.exec(`
  INSERT OR IGNORE INTO device_clients (device_hash, client_id)
  SELECT DISTINCT device_hash, 'demo' FROM events
`);
```

Dos problemas distintos:

1. **El token `demo-token-dev-only` se recrea incondicionalmente en cada arranque.** Está en el código, está en el repositorio, y está publicado en `docs/CHANGELOG.md:16`. Es una credencial permanente y conocida.

2. **La asignación automática a `demo` corre en cada arranque, no una sola vez.** Cualquier `device_hash` presente en `events` sin fila en `device_clients` queda asignado a `demo`. Como `device_hash` es `PRIMARY KEY` en `device_clients` (`server.js:30`), la asignación posterior al municipio correcto mediante `INSERT` será ignorada silenciosamente si el panel admin usa `INSERT OR IGNORE`, o fallará si usa `INSERT` a secas.

**Por qué importa.** El flujo operativo real es: se registra el dispositivo en Traccar y se entrega al beneficiario (`docs/ONBOARDING_MUNICIPIO.md:69-96`), y la asignación al municipio se hace en un paso posterior y manual. Entre ambos momentos el dispositivo ya emite eventos. Ese es exactamente el hueco por el que el dispositivo cae en `demo`.

**Escenario de falla.** Se entregan 50 dispositivos a la Municipalidad de Maipú un viernes. Durante el fin de semana emiten conexión/desconexión. El lunes hay un `pm2 restart` por un despliegue. Los 50 `device_hash` quedan asignados a `demo`. Cuando el administrador los asigna a `maipu`, el `INSERT OR IGNORE` no hace nada. El dashboard de Maipú muestra cero dispositivos y nadie entiende por qué. Peor aún: cualquiera con el token `demo-token-dev-only` —que está publicado en el CHANGELOG del repositorio— ve los datos de los 50 adultos mayores de Maipú.

**Recomendación.** Eliminar el bloque completo de `server.js:36-44` del arranque. Convertirlo en un script de migración de un solo uso que se ejecute manualmente. El cliente `demo` debe existir solo en entornos de desarrollo, controlado por una variable de entorno, con un token generado aleatoriamente y nunca versionado. El panel admin debe usar `INSERT ... ON CONFLICT(device_hash) DO UPDATE SET client_id = ?` para que una reasignación funcione. Y debe existir un estado explícito "dispositivo sin asignar" que sea visible para SimpleCare, no un cliente comodín que acumula huérfanos.

---

### H10 — El dashboard entrega el rastro individual de cada persona, lo que debilita la afirmación de anonimización

**Severidad: Alto**

**Qué está mal.** `server.js:217-241` (`/riesgo`) entrega, por persona, el conteo de caídas, el conteo de SOS y la fecha de la última alerta. `server.js:245-257` (`/dispositivo/:id`) entrega la secuencia completa de eventos con coordenadas y timestamps de un individuo. `dashboard.html:305-332` los pinta en un mapa. `dashboard.html:160` los titula "Personas que requieren seguimiento".

Esto no es agregación estadística: es un perfil longitudinal por individuo con identificador estable. Técnicamente es pseudonimización, no anonimización.

**Por qué importa.** El municipio no es un tercero neutral: es quien selecciona a los beneficiarios del programa. Conoce sus nombres, sus direcciones y su cantidad por barrio. Con esa información previa, un ID anónimo estable más una zona de ~1,1 km más un patrón temporal de eventos permite reidentificar en muchos casos, sobre todo donde hay pocos beneficiarios por zona. `docs/PRIVACIDAD.md:46` afirma que la lista de correspondencia existe únicamente en SimpleCare, lo que es cierto, pero irrelevante: el municipio no necesita la lista, tiene el contexto.

No estoy afirmando que el diseño incumpla la Ley 21.719 —eso requiere criterio legal, no técnico—. Estoy afirmando que la afirmación categórica de `docs/PRIVACIDAD.md:7` (*"es técnicamente imposible reidentificar"*) no está sustentada por el diseño actual y no debería usarse como argumento comercial sin revisión legal.

**Escenario de falla.** Un municipio tiene 12 beneficiarios en una comuna pequeña. El panel de riesgo muestra un ID con 8 caídas en el último mes y su zona. El funcionario, que conoce a los 12 y sabe quién vive en esa zona, identifica a la persona sin esfuerzo. Puede que eso sea deseable desde el punto de vista asistencial —y probablemente lo sea— pero entonces el sistema debe describirse honestamente como lo que es, con consentimiento acorde, y no como un panel de datos anónimos.

**Recomendación.**
1. Aplicar un umbral de k-anonimato: no mostrar celdas del mapa de calor ni filas del panel de riesgo cuando el conteo de individuos distintos en esa zona o período sea menor a un umbral (5 es el valor habitual).
2. Definir explícitamente si `/dispositivo/:id` debe existir en el producto municipal. Es la funcionalidad que más tensiona el modelo de privacidad y la que menos aporta a la "planificación social" que es la propuesta de valor declarada.
3. Someter `docs/PRIVACIDAD.md` a revisión legal antes de firmar con el primer municipio real, con foco en la reidentificación por conocimiento auxiliar del receptor.
4. Ajustar el lenguaje del dashboard: `dashboard.html:106` afirma "Sin información personal" y `dashboard.html:182` invoca la Ley 21.719 como respaldo. Ambas afirmaciones deben validarse antes de mostrarse a un cliente.

---

### H11 — Sin backups, con el comando de borrado documentado como receta

**Severidad: Alto**

**Qué está mal.** No hay ningún script, cron ni configuración de respaldo en el repositorio. `docs/SEGURIDAD.md:65-67` lo reconoce como pendiente. `CONTINUAR.md:152-157` documenta, listo para copiar y pegar, un `DELETE FROM events` sin confirmación ni respaldo previo.

**Por qué importa.** El histórico anonimizado es el activo que justifica la suscripción del municipio. No es recuperable de ninguna otra fuente: Traccar tiene su propia base H2 con las posiciones, pero no con los eventos anonimizados ni con la estructura que consume el dashboard, y su retención no fue verificada.

**Escenario de falla.** Alguien retomando el proyecto lee `CONTINUAR.md`, ve el bloque titulado "Para borrarlos cuando haya datos reales", y lo ejecuta sin advertir que a esa altura ya hay datos reales mezclados con los simulados. Dos años de histórico municipal desaparecen. No hay copia.

**Recomendación.** Cron diario con `sqlite3 events.db ".backup"` (respaldo consistente, a diferencia de `cp` sobre una base activa) hacia almacenamiento fuera del VPS, con retención de al menos 30 días y verificación periódica de restauración. Reemplazar el bloque de `CONTINUAR.md:152-157` por un `DELETE` acotado a las filas simuladas por rango de fechas, precedido de un respaldo obligatorio.

---

### H12 — Toda la analítica usa `created_at` (hora de llegada en UTC) y no `timestamp` (hora del evento)

**Severidad: Medio**

**Qué está mal.** El campo `timestamp` se guarda en `server.js:89` desde `event.eventTime`, pero **ninguna consulta lo usa**. Los ocho endpoints filtran, agrupan y ordenan por `created_at`, que es `datetime('now')` de SQLite, es decir la hora UTC en que Node procesó el webhook.

Además, `created_at` está en UTC mientras el usuario razona en hora de Chile (UTC−4 en invierno, UTC−3 en verano). `dashboard.html:359-362` construye los filtros de fecha con `toISOString()`, que también es UTC, así que hay consistencia interna, pero `dashboard.html:242` y `dashboard.html:322` sí convierten a hora local para mostrar. El resultado es que un evento ocurrido a las 21:30 hora de Chile se muestra con fecha del día correcto pero se filtra como si hubiera ocurrido al día siguiente.

**Por qué importa.** El desfase se acumula en un producto cuya propuesta de valor es el análisis de patrones. Un análisis de "a qué hora del día ocurren más caídas" —una pregunta natural para planificación social, y probablemente la más valiosa que el municipio puede hacer— daría un resultado corrido en 3 o 4 horas. Y si en algún momento hay reprocesamiento o llegada diferida de eventos, `created_at` deja de tener relación con cuándo ocurrió el hecho.

**Recomendación.** Migrar todas las consultas analíticas a `timestamp`, dejando `created_at` solo para auditoría de ingesta. Normalizar la zona horaria de forma explícita: guardar en UTC y convertir a `America/Santiago` en la capa de consulta, o al menos documentar la convención. Verificar que `event.eventTime` viene poblado en todos los tipos de evento antes de hacer la migración.

---

### H13 — Sin monitoreo de dispositivos silenciosos

**Severidad: Medio** (Alto como riesgo de producto)

**Qué está mal.** El sistema registra `deviceOnline` y `deviceOffline` (`server.js:109`) y los grafica en `/utilization`, pero nadie los evalúa. No hay alerta cuando un dispositivo lleva días sin reportar.

**Por qué importa.** Un EV07B con la batería agotada, con la SIM sin saldo o simplemente guardado en un cajón es indistinguible, desde el dashboard, de uno que funciona pero no ha tenido alarmas. La persona cree estar protegida y no lo está. Con 1.000 dispositivos en terreno, la tasa de dispositivos silenciosos será significativa y su detección manual es inviable.

**Recomendación.** Trabajo periódico que identifique dispositivos sin eventos en las últimas 48 h y genere una lista de seguimiento. Exponerla en el dashboard municipal como métrica operativa ("dispositivos que requieren revisión") y notificarla a SimpleCare. Es, además, una funcionalidad vendible: demuestra al municipio que el servicio se mantiene activo. La alarma `low_battery` ya se captura y es la señal temprana natural para esto.

---

### H14 — Colisión de prefijos de 8 caracteres en el identificador anónimo

**Severidad: Medio**

**Qué está mal.** `server.js:226` expone `substr(device_hash, 1, 8)` como `id_anonimo`, y `server.js:245-257` lo usa como criterio de búsqueda para el historial individual. Ocho caracteres hexadecimales son 32 bits.

**Por qué importa.** Con 1.000 dispositivos, la probabilidad de que existan al menos dos con el mismo prefijo de 8 caracteres es de aproximadamente 1,2 % (paradoja del cumpleaños). Es baja, pero no despreciable, y si ocurre, `/dispositivo/:id` mezcla en un mismo mapa el historial de dos personas distintas. La consulta filtra por `client_id`, así que la mezcla queda contenida dentro de un mismo municipio, pero el resultado sigue siendo un panel de riesgo que atribuye eventos a la persona equivocada.

**Recomendación.** Usar el `device_hash` completo de 16 caracteres como clave en la API y mostrar los 8 primeros solo como etiqueta visual. El cambio es acotado: `server.js:226`, `server.js:250` y `dashboard.html:286`.

---

### H15 — Dependencias del frontend cargadas desde CDNs, una de ellas sin versión fijada

**Severidad: Medio**

**Qué está mal.** `dashboard.html:7-10` carga cuatro recursos desde tres orígenes externos. `dashboard.html:10` (`https://cdn.jsdelivr.net/npm/chart.js`) **no especifica versión**: siempre entrega la última publicada, incluyendo cambios de versión mayor. `dashboard.html:9` carga desde `leaflet.github.io`, que es GitHub Pages y no un CDN con garantía de disponibilidad. Ninguno usa Subresource Integrity.

**Por qué importa.** Dos riesgos. Primero, disponibilidad y estabilidad: una versión mayor nueva de Chart.js con cambios incompatibles rompe los gráficos del dashboard de todos los municipios simultáneamente, sin que se haya tocado una línea de código. Segundo, cadena de suministro: cualquiera de esos scripts se ejecuta con acceso completo a la página, incluyendo el token que está en la URL (H05).

**Recomendación.** Fijar la versión exacta de Chart.js. Agregar atributos `integrity` y `crossorigin` a los cuatro recursos. Mejor aún: descargar las librerías y servirlas desde `/opt/simplecare/public/`, lo que además elimina la dependencia de Internet para el rendimiento del dashboard y evita filtrar la existencia del panel a terceros por el encabezado `Referer`.

---

### H16 — Sin límite de peticiones en ningún endpoint

**Severidad: Medio**

**Qué está mal.** No hay `express-rate-limit` ni equivalente en `server.js`. `docs/SEGURIDAD.md:57-59` lo reconoce.

**Por qué importa.** Un token filtrado permite golpear `/export` (H08) en bucle y dejar el servicio inoperativo con una sola conexión doméstica. También permite enumerar tokens contra el middleware `requireClient` sin ninguna traba, y ensuciar la base vía `/webhook` (H06).

**Recomendación.** `express-rate-limit` con límites distintos por ruta: generoso en `/webhook` (debe absorber ráfagas legítimas de 1.000 dispositivos), estricto en `/export`, moderado en el resto. Agregar penalización creciente sobre respuestas 403 del middleware de token.

---

### H17 — Sin registro de accesos ni auditoría

**Severidad: Medio**

**Qué está mal.** Los únicos registros son dos `console.log` en `server.js:108` y `server.js:116`, ambos en el webhook. Ningún endpoint de consulta registra quién accedió, desde dónde, ni qué consultó. `docs/SEGURIDAD.md:61-63` lo reconoce.

**Por qué importa.** Si un token se filtra, no hay forma de saber si se usó, cuándo ni desde qué IP. Tampoco hay forma de demostrarle a un municipio que sus datos no fueron consultados por otro, ni de cumplir una eventual obligación de notificación de brecha bajo la Ley 21.719. Y para el negocio, no hay ninguna métrica de uso real del dashboard, que es información valiosa a la hora de renovar un contrato.

**Recomendación.** Middleware de registro con timestamp, `client_id`, IP, ruta y código de respuesta, escrito a archivo con rotación. Configurar `pm2 install pm2-logrotate` (pendiente en `docs/SEGURIDAD.md:100`), sin lo cual los registros llenan el disco y provocan H02.

---

### H18 — `/stats` ignora el filtro de fechas y devuelve el histórico completo

**Severidad: Bajo**

**Qué está mal.** `server.js:123-131` no acepta `desde` ni `hasta`, a diferencia de los otros siete endpoints. `dashboard.html:341` lo llama solo con el token, y `dashboard.html:247-259` filtra el resultado en el navegador. El comportamiento es consistente entre backend y frontend, así que no hay error visible, pero el volumen transferido crece sin cota con el histórico y el gráfico mensual ignora el rango de fechas que el usuario seleccionó — lo que probablemente sorprenda al funcionario que acaba de elegir un rango.

**Recomendación.** Aceptar `desde`/`hasta` en `/stats` y aplicarlos en SQL, por coherencia con el resto de la API y con lo que el usuario espera del filtro.

---

### H19 — La documentación contradice al código y se contradice a sí misma

**Severidad: Bajo** (Medio por su efecto sobre la velocidad de trabajo futura)

Contradicciones verificadas:

| Ubicación | Dice | Realidad en el código |
|---|---|---|
| `CONTINUAR.md:20` | "Multi-tenant ❌ No implementado" | Implementado (`server.js:23-55`) |
| `CONTINUAR.md:21` | "Autenticación dashboard ❌ No implementada" | Implementada en los 8 endpoints de datos |
| `CONTINUAR.md:64-71` | "1. Multi-tenant backend ← AHORA" | Ya terminado |
| `CONTINUAR.md:18` vs `CONTINUAR.md:54` | `templateLanguage=es_CL` vs `templateLanguage = es` | Contradicción **dentro del mismo archivo** |
| `docs/DEPLOY.md:163` | `templateLanguage` → `es` | `docs/CHANGELOG.md:34` dice `es_CL` |
| `docs/APRENDIZAJES.md:68-76` (A006) | "WhatsApp Cloud API no tiene código estándar `es_CL`" | `docs/CHANGELOG.md:30` dice que `es_CL` **es** el código correcto y que A006 partía de un supuesto errado. A006 nunca se corrigió. |
| `docs/ONBOARDING_MUNICIPIO.md:46` | "actualmente el backend no tiene multi-tenant" | Lo tiene |
| `docs/ONBOARDING_MUNICIPIO.md:49-50` | `INSERT INTO clients (..., logo_path)` | La columna `logo_path` no existe (`server.js:23-27`) |
| `docs/ARQUITECTURA.md:61` | "Una sola tabla: `events`" | Son tres tablas |
| `docs/DEPLOY.md:104` | `scp server/public/dashboard.html` | En el repositorio está en `server/dashboard.html` |
| `docs/API.md` completo | No documenta el parámetro `token`, ni las respuestas 401/403, ni la ruta `/dashboard/:clientId` | Todo eso existe desde la versión 0.3.0 |
| `docs/PRIVACIDAD.md:39-46` | El hash es del IMEI y es irreversible | Es del `deviceId` de Traccar y es reversible (H01) |

`docs/APRENDIZAJES.md` es, en contraste, un activo de calidad notable: A013, A014 y A015 son hallazgos de alto valor bien documentados. El problema no es la calidad de la documentación sino que su actualización va detrás del código, con el agravante de que A006 quedó registrado con una conclusión que después se demostró incorrecta y que quien lo lea hoy sin leer el CHANGELOG completo tomará por válida.

**Recomendación.** Actualizar `CONTINUAR.md` para reflejar el estado real, corregir A006 con una nota de "supuesto refutado, ver CHANGELOG 0.2.1", y agregar la autenticación a `docs/API.md`. Como práctica: la fuente de verdad del estado debe ser el CHANGELOG, y `CONTINUAR.md` debe reescribirse completo al cierre de cada sesión, no editarse parcialmente.

---

### H20 — El repositorio no tiene `package.json` y el código se sincroniza a mano

**Severidad: Bajo**

**Qué está mal.** El repositorio contiene solo `server/server.js` y `server/dashboard.html`. No hay `package.json` ni `package-lock.json`, pese a que `docs/DEPLOY.md:92` instruye `npm install express better-sqlite3` sin versiones. `CONTINUAR.md:144` establece que la sincronización VPS→repositorio es manual.

**Por qué importa.** Reconstruir el servidor desde cero instalaría las versiones más recientes de Express y `better-sqlite3`, que pueden no ser las que están probadas en producción — Express 5 tiene cambios incompatibles en el enrutamiento respecto de Express 4. Y la sincronización manual garantiza deriva: ya ocurrió, es la causa raíz de A014 (`docs/APRENDIZAJES.md:169-182`), donde se creyó actualizado un archivo que nunca cambió.

**Recomendación.** Versionar `package.json` y `package-lock.json`. Reemplazar la copia manual por un `git pull` en el VPS como paso de despliegue, con el repositorio como origen único. Es la corrección más barata de este informe y elimina toda una categoría de errores.

---

## 4. Riesgos al escalar a 1.000 dispositivos

Estimación de volumen base: 1.000 dispositivos × ~10 eventos/día (conexión, desconexión, batería, alarmas ocasionales) ≈ **10.000 eventos/día, 3,65 millones de filas al año, del orden de 300–400 MB**. Las alarmas reales (SOS y caída) serán un porcentaje muy menor de ese total.

### SQLite bajo concurrencia y volumen

**Veredicto: no es el problema principal, pero necesita tres cambios.**

10.000 escrituras al día son 0,12 escrituras por segundo en promedio. SQLite maneja varios órdenes de magnitud más. El archivo de 300–400 MB anuales está muy por debajo de cualquier límite. La decisión D001 de `docs/DECISIONES.md:7-18` sigue siendo correcta a esta escala.

Los problemas concretos son otros tres, todos resolubles sin cambiar de motor:
- **Sin índices** (H07): el volumen de lectura del dashboard es lo que duele, no el de escritura.
- **Sin modo WAL**: en el modo por defecto, cada escritura del webhook bloquea a los lectores del dashboard y viceversa. Con WAL, lectores y escritor no se bloquean entre sí. Es una línea de código.
- **`better-sqlite3` es síncrono**: toda consulta corre en el hilo del event loop, así que una consulta lenta bloquea la ingesta de alarmas. Este es el riesgo real y no se arregla con índices solamente (aunque los índices lo reducen drásticamente).

Recomendación de umbral revisada: migrar a PostgreSQL cuando haya más de 10 municipios activos consultando en paralelo o cuando aparezcan necesidades de consulta analítica que SQLite no cubra, no por tamaño de archivo.

### PM2 en un solo proceso

**Riesgo: Alto, principalmente por la ausencia de ventana de gracia.**

Un solo proceso significa que cualquier excepción no capturada mata el servidor completo. PM2 lo reinicia en un segundo o dos, pero durante ese lapso —más el tiempo de arranque, que incluye la migración de normalización de `server.js:74-80` que crece con el histórico (H07)— todo webhook entrante recibe conexión rechazada y se pierde de forma definitiva (H02).

El modo cluster de PM2 es viable con SQLite en modo WAL, pero no resuelve el problema de fondo, que es que ingesta y consulta compartan proceso. La separación correcta es por responsabilidad, no por número de instancias:

- **Proceso de ingesta:** solo `/webhook`. Mínimo código, mínimas dependencias, la máxima estabilidad posible. Nunca ejecuta consultas analíticas.
- **Proceso de consulta:** dashboard y API, base abierta en modo solo lectura. Si se cae, no se pierde ninguna alarma.
- **Proceso trabajador:** envío de WhatsApp desde la cola (H03).

`docs/APRENDIZAJES.md:94-101` (A008) documenta un episodio de 1.041 reinicios en bucle. Con la arquitectura actual, todo ese período fue de pérdida total de eventos.

### Punto único de falla: el VPS

**Riesgo: Alto y estructural.**

Un solo servidor concentra la terminación del protocolo GPS (puerto 5187, la dirección a la que apuntan los 1.000 dispositivos en terreno), Traccar, Node.js, la base de datos y el dashboard. Si el VPS cae, deja de funcionar el sistema completo, incluyendo las alertas de emergencia.

Consideración crítica y **no verificable desde el repositorio**: ¿los EV07B almacenan y reenvían los eventos cuando el servidor no responde, o los descartan? De la respuesta depende si una caída de dos horas del VPS significa "dos horas de datos que llegan tarde" o "dos horas sin sistema de alarma". Esto debe verificarse contra la documentación del fabricante o mediante una prueba controlada (apagar Traccar, activar el botón, restaurar, ver si el evento aparece). **Es la prueba individual de mayor valor que se puede ejecutar antes de escalar.**

Adicionalmente, cambiar de servidor requiere reconfigurar los 1.000 dispositivos en terreno, porque apuntan a una IP. Configurarlos contra un nombre de dominio en vez de `2.24.196.49` es una decisión barata hoy e imposiblemente cara con el parque desplegado.

### Ausencia de backups

Ya cubierto en H11. A 1.000 dispositivos el impacto se multiplica: se pierde el histórico de varios municipios simultáneamente, con obligaciones contractuales de por medio.

### Ausencia de monitoreo y alertas

**Riesgo: Alto.** No hay endpoint de salud, ni monitor externo, ni alerta de disco, ni alerta de "no llegan eventos", ni alerta de token de Meta próximo a expirar, ni alerta de dispositivos silenciosos (H13). El mecanismo de detección de fallas del sistema es, hoy, que un cliente reclame. Para un producto de alarma, eso significa que la falla se detecta después de la emergencia que no se atendió.

Costo de solucionarlo: bajo. Un `/health`, una cuenta gratuita de Healthchecks.io o UptimeRobot, y un cron que verifique el token de Meta con el `curl` que ya está documentado en `CONTINUAR.md:31`. Es probablemente la mejor relación entre esfuerzo e impacto de todo este informe.

### Límites de la API de Meta

Los valores exactos y vigentes deben confirmarse en la documentación de Meta —no puedo verificarlos desde aquí y cambian con cierta frecuencia—, pero los mecanismos a considerar son:

- **Escalones de mensajería.** Una cuenta nueva parte en un escalón bajo de destinatarios únicos por período de 24 horas y sube según volumen y calidad. Con 1.000 usuarios, **cada contacto familiar es un destinatario único distinto**, así que el escalón inicial puede ser insuficiente desde el primer mes de operación a escala. El ascenso de escalón no es inmediato ni automático en el sentido de estar bajo control propio.
- **Verificación de negocio.** Punto 4 del plan. Es requisito para salir del sandbox, donde solo se puede enviar a un puñado de números de prueba preverificados. Es un proceso con tiempos de respuesta de Meta que no se controlan, así que debe iniciarse mucho antes de comprometer una fecha con un municipio.
- **Calificación de calidad de la plantilla.** Este es el riesgo más subestimado. Si los familiares bloquean o reportan los mensajes, la calidad de la plantilla baja y Meta puede **pausarla**. Una plantilla pausada significa que **ninguna alarma se entrega**. El riesgo es real porque un mensaje automático desde un número desconocido es exactamente el patrón que la gente reporta como spam. Mitigación: onboarding explícito de la familia, número de remitente con nombre verificado, y **alerta operativa inmediata si el estado de la plantilla cambia**.
- **Límite de mensajes por segundo.** No es un problema para alarmas reales, que son eventos raros y dispersos. Sí lo sería si un error de código provocara un bucle de reenvío — razón adicional para el máximo de reintentos de H03.
- **Costo.** Meta cobra por conversación iniciada por el negocio. A 1.000 usuarios conviene modelar ese costo dentro del precio de la suscripción antes de firmar contratos plurianuales.

### Qué pasa si Traccar o Node.js se caen

| Escenario | Hoy | Después del cambio planificado |
|---|---|---|
| **Node.js caído** | La familia **sí** recibe el WhatsApp (Traccar lo envía). Se pierde el registro para el municipio. | La familia **no** recibe nada. La alarma se pierde por completo y en silencio. |
| **Traccar caído** | No se recibe nada del dispositivo. Pérdida total. Depende de si el EV07B reenvía (sin verificar). | Igual. |
| **Meta caído o token expirado** | Fallo silencioso, sin registro (A013). | Igual de silencioso, salvo que se implemente la detección de la respuesta de error. Con cola persistente, recuperable al restaurarse. |
| **Disco lleno** | SQLite falla, evento perdido sin traza (H02). WhatsApp sigue funcionando. | WhatsApp también falla. |
| **Reinicio de PM2** | Ventana de segundos de pérdida de registro. | Ventana de segundos de pérdida de **alarmas**. |

La conclusión de esta tabla es directa: **hoy el sistema tolera una caída de Node.js sin dejar a nadie sin auxilio; después del cambio, no.** Esa propiedad hay que reconstruirla deliberadamente (cola persistente, reintentos, monitoreo) porque hoy se tiene por accidente.

---

## 5. Riesgos de la arquitectura planificada

### Notificación WhatsApp desde `server.js` — evaluación crítica

**Lo que gana (y es real y necesario):**
- Contacto familiar por dispositivo, que es un requisito de producto ineludible. Traccar simplemente no lo modela.
- Control total del contenido del mensaje: tipo de alarma, hora, zona, enlace a la PWA.
- Posibilidad de registrar, reintentar y auditar cada envío — cosa que hoy es imposible.
- Independencia del modelo de usuarios de Traccar, que no calza con el dominio del negocio.
- Habilita la PWA (punto 5) y el escalamiento a segundo contacto.

**Lo que se rompe:**
- Se elimina la independencia entre el camino de alerta y el camino de analítica (ver tabla anterior). Es la pérdida más importante y no está mencionada en `CONTINUAR.md:35` ni en `docs/DECISIONES.md:146-155`.
- El proceso que hoy puede reiniciarse sin consecuencias graves pasa a ser crítico para la seguridad de personas. Todo el manejo de errores, despliegue y monitoreo tiene que subir de nivel en consecuencia.
- Los datos personales entran en el sistema (H04), con las implicancias legales correspondientes.
- El webhook abierto (H06) pasa de ser un problema de calidad de datos a ser una vía para enviar mensajes falsos a familias reales.

**Lo que falta en el plan:**

| Elemento faltante | Por qué es indispensable |
|---|---|
| **Cola persistente (outbox)** | Sin ella, cualquier falla transitoria de Meta pierde la alarma. Con ella, se recupera sola. Es el elemento estructural que hace todo lo demás posible. |
| **Idempotencia** | Traccar puede reenviar; un reinicio a mitad de proceso puede duplicar. Sin `traccar_event_id UNIQUE`, la familia recibe la misma alarma varias veces, lo que degrada la calidad de la plantilla en Meta y erosiona la confianza. |
| **Reintentos con retroceso exponencial y dead-letter** | Un 429 o un 503 de Meta es transitorio y debe reintentarse. Un fallo definitivo debe generar alerta humana, no desaparecer. |
| **Timeout en la llamada a Meta** | Sin timeout explícito, una respuesta lenta deja recursos colgados y confunde el estado del envío. |
| **Verificación de la respuesta de Meta** | Hoy el fallo es silencioso (A013). Si se replica ese patrón, el cambio no mejora nada respecto de Traccar: solo traslada el silencio de un componente a otro. |
| **Webhooks de estado de Meta** | Distinguir "enviado" de "entregado" de "leído". Sin esto no se sabe si la familia recibió la alarma, que es la única pregunta que realmente importa. Requiere validar `X-Hub-Signature-256`. |
| **Gestión del token** | El token de 24 h es incompatible con una función de emergencia. Migrar a token de usuario de sistema, con verificación programada y alerta anticipada de vencimiento. |
| **Separación de datos personales** | H04. La tabla de contactos no puede vivir en `events.db`. |
| **Período de operación en paralelo** | No desactivar el notificador de Traccar hasta tener historial demostrado de entregas por la ruta nueva. |
| **Trazabilidad completa** | Por cada alarma: cuándo llegó, a quién se intentó notificar, cuántos intentos, resultado final. Es requisito operativo y, ante un incidente con un adulto mayor, requisito probatorio. |

### Riesgos de los demás puntos del plan

**Panel admin (punto 2).** Es el componente que introduce datos personales al sistema. Debe tener autenticación propia, distinta del token de municipio, y no debería estar expuesto a Internet. El riesgo mayor es construirlo como unas rutas más dentro del mismo `server.js`, que es el camino natural y el equivocado: mezclaría en un proceso el manejo de datos personales, la ingesta de alarmas y el acceso de clientes externos. Debe resolver además el problema de asignación de H09 con `ON CONFLICT DO UPDATE`.

**HTTPS + subdominio (punto 3).** Correcto y necesario. Debe adelantarse. Dos advertencias: los dispositivos siguen apuntando a la IP en el puerto 5187 (Nginx no los cubre); y al poner Nginx delante hay que configurar `trust proxy` en Express y asegurarse de no registrar las query strings con tokens (H05).

**Verificación de Meta Business (punto 4).** Debe iniciarse ya. Los tiempos de respuesta de Meta no se controlan y es bloqueante para cualquier operación real.

**PWA para familias (punto 5).** Es el punto de mayor salto de complejidad y el menos analizado. "Comandar el dispositivo a distancia" implica: autenticación de usuarios finales (no un token en la URL — el modelo actual no sirve aquí), autorización por dispositivo, un canal de comandos hacia el EV07B a través de Traccar, y el manejo de datos personales de las familias. Es un producto distinto del dashboard municipal, con un modelo de seguridad distinto, y probablemente merezca su propio servicio. No debería construirse sobre `server.js` ni compartir su base de datos.

---

## 6. Deuda técnica actual

Referencias a archivo:línea, ordenadas por severidad.

| # | Ubicación | Deuda |
|---|---|---|
| 1 | `server.js:86` | `sha256(String(event.deviceId))` sin sal sobre un entero de rango pequeño — reversible por fuerza bruta (H01) |
| 2 | `server.js:104-119` | Webhook sin `try/catch`, sin idempotencia, sin persistencia del `event.id`, sin registro de descartes (H02) |
| 3 | `server.js:11-21` | Tabla `events` sin ningún índice (H07) |
| 4 | `server.js:9` | Sin `pragma('journal_mode = WAL')` — escritores bloquean lectores |
| 5 | `server.js:36-44` | Cliente `demo` con token fijo recreado en cada arranque; asignación automática de huérfanos (H09) |
| 6 | `server.js:37` | Credencial `'demo-token-dev-only'` en el código fuente, versionada y publicada en `docs/CHANGELOG.md:16` |
| 7 | `server.js:49` | Token leído desde la query string (H05) |
| 8 | `server.js:74-80` | Migración de normalización ejecutada en cada arranque, con costo lineal sobre el histórico (H07) |
| 9 | `server.js:273-287` | `/export` sin `LIMIT`, materializa todo en memoria de forma síncrona (H08) |
| 10 | `server.js:89` + todos los endpoints | El campo `timestamp` se guarda pero ninguna consulta lo usa; todo el análisis se hace sobre `created_at` (H12) |
| 11 | `server.js:226, 245-257` | Identificador de 8 caracteres hexadecimales, con riesgo de colisión de ~1,2 % a 1.000 dispositivos (H14) |
| 12 | `server.js:97-100` | `/dashboard` no valida token (no expone datos, pero permite enumerar la existencia del panel); además `readFileSync` en cada petición, sin caché |
| 13 | `server.js:90-91` | `position?.latitude ? ... : null` — una latitud o longitud exactamente 0 se guardaría como `null`. Sin impacto en Chile, pero es una comprobación de veracidad donde corresponde una de nulidad (`!= null`) |
| 14 | `server.js` completo | Sin endpoint `/health`, sin límite de peticiones, sin registro de accesos, sin `helmet` ni encabezados de seguridad (H02, H16, H17) |
| 15 | `server.js:9, 99` | Rutas absolutas `/opt/simplecare/...` codificadas — impide ejecutar el código fuera del VPS, incluyendo cualquier prueba local |
| 16 | `server.js:123-131` | `/stats` ignora `desde`/`hasta`, a diferencia de los otros siete endpoints (H18) |
| 17 | `server.js:135-288` | El patrón de construcción de filtros de fecha está copiado siete veces con variaciones menores (`desde`/`hasta`/`dc`/`and`). Un cambio en la lógica de fechas requiere siete ediciones coherentes |
| 18 | `dashboard.html:10` | `chart.js` sin versión fijada — actualización de versión mayor rompe el dashboard sin aviso (H15) |
| 19 | `dashboard.html:7-10` | Cuatro recursos externos sin Subresource Integrity, uno desde GitHub Pages (H15) |
| 20 | `dashboard.html:243, 285-292` | Construcción de HTML por concatenación de strings con datos de la base. Hoy los valores son controlados, pero es el patrón que se convierte en XSS en cuanto entre un nombre de municipio o una nota de texto libre |
| 21 | `dashboard.html:263, 337-343` | Los fetch no comprueban `r.ok`: una respuesta 401 o 403 se parsea como JSON y falla en el `catch` genérico, dejando al usuario con un dashboard vacío y sin explicación |
| 22 | Repositorio | Sin `package.json` ni `package-lock.json` (H20) |
| 23 | Repositorio | Sin pruebas automatizadas ni integración continua. La verificación de aislamiento entre tenants (`docs/CHANGELOG.md:14`) fue manual y no es repetible |
| 24 | `CONTINUAR.md:144` | Sincronización VPS↔repositorio manual — causa raíz documentada de A014 (H20) |
| 25 | `CONTINUAR.md:152-157` | Comando `DELETE FROM events` documentado listo para pegar, sin respaldo previo (H11) |
| 26 | Varios documentos | Contradicciones entre documentación y código, y entre documentos (H19) |

---

## 7. Recomendaciones priorizadas

Esfuerzo: **bajo** ≈ menos de medio día · **medio** ≈ 1 a 3 días · **alto** ≈ más de una semana.

### Bloque 0 — Antes del primer municipio real que pague

| # | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 1 | Agregar `try/catch` al webhook, con respaldo del payload crudo a disco ante cualquier excepción | Bajo | **Crítico** — cierra la pérdida silenciosa de alarmas (H02) |
| 2 | Endpoint `/health` + monitor externo gratuito con alerta por "sin eventos en N horas" | Bajo | **Crítico** — el sistema deja de fallar sin que nadie se entere (H02) |
| 3 | Respaldo diario de `events.db` fuera del VPS, con prueba de restauración | Bajo | **Crítico** — protege el activo vendido (H11) |
| 4 | Salar el hash del dispositivo con un secreto fuera del repositorio; corregir `PRIVACIDAD.md` y `DECISIONES.md` | Bajo | **Crítico** — restaura la validez de la afirmación de anonimización (H01) |
| 5 | Cerrar el puerto 3000 a Internet en UFW (dejar solo `172.17.0.0/16`) y agregar secreto compartido al webhook | Bajo | **Crítico** — elimina la inyección de eventos (H06) |
| 6 | Crear los tres índices y activar el modo WAL | Bajo | **Alto** — resuelve el 80 % del riesgo de escala de SQLite (H07) |
| 7 | Eliminar el cliente `demo` y la asignación automática de huérfanos del arranque | Bajo | **Alto** — cierra una fuga entre tenants y un error de asignación silencioso (H09) |
| 8 | HTTPS con Nginx + Certbot en `panel.simplecare.cl`; mover el token de la query string al header o a cookie | Medio | **Alto** — protege el token en tránsito (H05) |
| 9 | Versionar `package.json` y `package-lock.json`; reemplazar la copia manual por `git pull` en el despliegue | Bajo | **Alto** — elimina la deriva entre repositorio y producción (H20) |
| 10 | Verificar experimentalmente si el EV07B reenvía eventos tras una caída del servidor | Bajo | **Alto** — determina si el VPS único es un riesgo tolerable o inaceptable |
| 11 | Iniciar la verificación de Meta Business | Bajo (esfuerzo propio; tiempo de espera externo) | **Alto** — bloqueante para operar; los plazos no se controlan |
| 12 | Actualizar `CONTINUAR.md`, corregir A006, documentar la autenticación en `API.md` | Bajo | **Medio** — evita que la siguiente sesión trabaje sobre supuestos falsos (H19) |

### Bloque 1 — Antes de mover WhatsApp a `server.js`

| # | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 13 | Agregar `traccar_event_id INTEGER UNIQUE` + `INSERT OR IGNORE` (idempotencia) | Bajo | **Crítico** — prerrequisito de cualquier reintento (H02, H03) |
| 14 | Tabla `outbox` con estados y trabajador desacoplado del handler HTTP | Medio | **Crítico** — es el corazón del rediseño (H03) |
| 15 | Reintentos con retroceso exponencial, tope de intentos y dead-letter con alerta humana | Medio | **Crítico** (H03) |
| 16 | Verificar la respuesta de Meta, distinguir errores recuperables de definitivos, alertar ante código 190 | Bajo | **Crítico** — elimina el fallo silencioso heredado de A013 (H03) |
| 17 | Migrar a token de usuario de sistema (60 días) con verificación programada y alerta de vencimiento | Bajo | **Crítico** (H03) |
| 18 | Base de datos separada para contactos, con control de acceso propio; actualizar `PRIVACIDAD.md` antes de escribir el código | Medio | **Crítico** — evita mezclar datos personales con la base anonimizada (H04) |
| 19 | Suscribirse a los webhooks de estado de Meta, validando `X-Hub-Signature-256` | Medio | **Alto** — permite saber si la alarma llegó, no solo si se envió (H03) |
| 20 | Operar en paralelo con el notificador de Traccar durante la transición | Bajo | **Alto** — evita quedar sin alertas si la ruta nueva falla (H03) |
| 21 | Panel admin con autenticación propia, no expuesto a Internet, con `ON CONFLICT DO UPDATE` en la asignación de dispositivos | Medio | **Alto** (H04, H09) |

### Bloque 2 — Antes de superar los 100 dispositivos en terreno

| # | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 22 | Separar el proceso de ingesta del de consulta (base en solo lectura para el dashboard) | Medio | **Alto** — una consulta pesada deja de poder bloquear una alarma (H07, H08) |
| 23 | `/export` con transmisión por `iterate()` y rango de fechas máximo obligatorio | Bajo | **Alto** (H08) |
| 24 | Detección de dispositivos silenciosos + alerta y métrica en el dashboard | Bajo | **Alto** — evita que alguien se crea protegido sin estarlo (H13) |
| 25 | `express-rate-limit` con límites por ruta | Bajo | **Medio** (H16) |
| 26 | Registro de accesos con rotación + `pm2-logrotate` | Bajo | **Medio** — auditoría y prevención del disco lleno (H17, H02) |
| 27 | Migrar la analítica de `created_at` a `timestamp`, con zona horaria explícita | Medio | **Medio** — corrige el sesgo en el análisis temporal (H12) |
| 28 | Fijar versión de Chart.js, agregar SRI o servir las librerías localmente | Bajo | **Medio** (H15) |
| 29 | Umbral de k-anonimato en mapa de calor y panel de riesgo; revisión legal de `PRIVACIDAD.md` | Medio | **Medio-Alto** — sostiene la afirmación comercial ante el municipio (H10) |
| 30 | Usar el `device_hash` completo como clave de API | Bajo | **Medio** (H14) |
| 31 | Pruebas automatizadas del aislamiento entre tenants y del procesamiento del webhook | Medio | **Medio** — convierte una verificación manual irrepetible en una garantía permanente |
| 32 | Migrar la configuración de los dispositivos de IP a nombre de dominio | Medio | **Alto a largo plazo** — hoy es barato; con 1.000 equipos en terreno es inviable |
| 33 | Extraer la construcción de filtros de fecha a una función común | Bajo | **Bajo** — reduce el riesgo de corregir seis de siete lugares (deuda 17) |

---

## Cierre

El sistema está bien construido para lo que es: un piloto que llegó a funcionar de extremo a extremo, con decisiones de diseño registradas y con un documento de aprendizajes de calidad poco común. La implementación multi-tenant que se acaba de terminar está correctamente hecha en lo que respecta al aislamiento de datos entre clientes, y fue verificada.

La brecha principal no está en las funcionalidades sino en las propiedades operativas: hoy el sistema no sabe cuándo falla, no puede recuperarse de una falla transitoria, no puede demostrar que entregó una alarma, y no tiene copia de sus datos. Mientras el WhatsApp lo envíe Traccar, esa brecha tiene un costo acotado. En el momento en que `server.js` asuma la entrega de las alertas —que es el próximo paso del plan y es el paso correcto— esas mismas propiedades pasan a ser la diferencia entre un servicio de emergencia y algo que solo lo parece.

Las doce acciones del Bloque 0 son casi todas de esfuerzo bajo y, en conjunto, se pueden abordar en unos pocos días. Hacerlas antes de escribir la primera línea del envío de WhatsApp desde `server.js` es la recomendación central de este informe.

Dos verificaciones concretas valen más que cualquier análisis adicional y ninguna de las dos se puede hacer desde el repositorio:
1. ¿El EV07B reenvía los eventos cuando el servidor no responde?
2. ¿Qué está corriendo realmente en `/opt/simplecare/server.js` en el VPS, y coincide con lo que hay en el repositorio?
